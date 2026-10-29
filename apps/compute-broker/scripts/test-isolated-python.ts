import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { createTencentAgsxSdkClient, type TencentAgsxSandboxLike } from "../src/tencent-agsx-provider";
import { executeIsolatedPython, IsolatedPythonExecutionError } from "../src/isolated-python/transport";

const root=resolve(import.meta.dirname,"../../..");loadEnv({path:resolve(root,".env"),quiet:true});
async function main(){
  if(process.env.DELEGATE_RUN_CLOUD_BOUNDARY_PROBE!=="1")throw new Error("explicit_opt_in_required");
  const label=process.argv[2]??"aio-launcher";if(!/^[a-z0-9-]+$/.test(label))throw new Error("invalid_label");
  const apiKey=process.env.TENCENT_AGS_API_KEY?.trim();const template=process.env.TENCENT_AGS_ALL_IN_ONE_TOOL?.trim();
  const domain=process.env.TENCENT_AGS_DOMAIN?.trim().replace(/^https?:\/\//u,"").replace(/\/$/u,"")||`${process.env.TENCENT_AGS_REGION?.trim()}.tencentags.com`;
  if(!apiKey||!template)throw new Error("configuration_missing");
  const client=createTencentAgsxSdkClient();const runId=`d04b-${randomUUID()}`;
  let sandbox:TencentAgsxSandboxLike|undefined;
  const report:Record<string,unknown>={startedAt:new Date().toISOString(),syntheticOnly:true,cases:[]};
  const privatePath=resolve(root,".local/agent-remediation/d04b-launcher-lease.json");
  await mkdir(resolve(root,".local/agent-remediation"),{recursive:true});
  await writeFile(privatePath,JSON.stringify({runId,cleanup:"creating"}),{mode:0o600});
  try{
    sandbox=await client.create({template,apiKey,domain,timeoutMs:180000,allowInternetAccess:true,metadata:{"delegate.probe":runId}});
    await writeFile(privatePath,JSON.stringify({runId,sandboxId:sandbox.sandboxId,cleanup:"pending"}),{mode:0o600});
    await sandbox.commands.run("mkdir -p /home/user/workspace/probe-inputs && printf 'a,b\\n1,2\\n' > /home/user/workspace/probe-inputs/data.csv && printf synthetic-private > /home/user/workspace/private.txt",{timeoutMs:5000});
    const cases=[
      {name:"arithmetic",source:"print(1+2+1009)",expected:"1012\n"},
      {name:"input",source:"import csv\nprint(list(csv.DictReader(open('/workspace/inputs/data.csv'))))",expected:"[{'a': '1', 'b': '2'}]\n"},
      {name:"filesystem_and_environment",source:"import os,pathlib,json\nprint(json.dumps({'private':pathlib.Path('/home/user/workspace/private.txt').exists(),'proc':pathlib.Path('/proc').exists(),'sys':pathlib.Path('/sys').exists(),'host':os.uname().nodename,'keys':sorted(os.environ)}))",expected:'{"private": false, "proc": false, "sys": false, "host": "delegate-code", "keys": ["HOME", "LANG", "LD_LIBRARY_PATH", "PATH", "TMPDIR"]}\n'},
      {name:"network_denied",source:"import socket\ntry: socket.socket(); print('UNEXPECTED')\nexcept PermissionError: print('denied')",expected:"denied\n"},
      {name:"fork_denied",source:"import os\ntry: os.fork(); print('UNEXPECTED')\nexcept PermissionError: print('denied')",expected:"denied\n"},
      {name:"limits_cannot_be_raised",source:"import resource\ntry: resource.setrlimit(resource.RLIMIT_AS,(resource.RLIM_INFINITY,resource.RLIM_INFINITY));print('UNEXPECTED')\nexcept (ValueError,PermissionError):print('denied')",expected:"denied\n"},
      {name:"timeout",source:"while True: pass",termination:"command_timeout",wallMs:500},
      {name:"output_limit",source:"while True: print('x'*1024)",termination:"output_limit",outputBytes:4096},
      {name:"memory_bound",source:"try: bytearray(300*1024*1024);print('UNEXPECTED')\nexcept MemoryError: print('bounded')",expected:"bounded\n"},
      {name:"readonly_inputs",source:"try: open('/workspace/inputs/data.csv','w').write('bad');print('UNEXPECTED')\nexcept OSError:print('readonly')",expected:"readonly\n"},
      {name:"standard_library_only",source:"import importlib.util\nprint(importlib.util.find_spec('requests') is None)",expected:"True\n"},
      {name:"cannot_regain_namespaces",source:"import ctypes\nc=ctypes.CDLL(None,use_errno=True)\nprint(c.unshare(0x10000000)==-1)",expected:"True\n"},
      {name:"capabilities_cleared",source:"import ctypes\nclass H(ctypes.Structure):_fields_=[('version',ctypes.c_uint),('pid',ctypes.c_int)]\nclass D(ctypes.Structure):_fields_=[('effective',ctypes.c_uint),('permitted',ctypes.c_uint),('inheritable',ctypes.c_uint)]\nh=H(0x20080522,0);d=(D*2)();c=ctypes.CDLL(None)\nprint(c.capget(ctypes.byref(h),ctypes.byref(d))==0 and all(x.effective==x.permitted==x.inheritable==0 for x in d))",expected:"True\n"},
      {name:"scratch_write",source:"open('/workspace/outputs/private.txt','w').write('own-execution')\nprint('created')",expected:"created\n"},
      {name:"scratch_not_reused",source:"import pathlib\nprint(pathlib.Path('/workspace/outputs/private.txt').exists())",expected:"False\n"},
      {name:"invalid_utf8",source:"import os\nos.write(1,b'\\xff')",termination:"invalid_output"},
      {name:"thread_denied",source:"import threading\ntry:\n t=threading.Thread(target=lambda:None);t.start();t.join();print('UNEXPECTED')\nexcept RuntimeError:print('denied')",expected:"denied\n"},
      {name:"file_size_bound",source:"import os\ntry: open('/workspace/outputs/big','wb').write(b'x'*(9*1024*1024));print('UNEXPECTED')\nexcept OSError:print(os.path.getsize('/workspace/outputs/big')<=8*1024*1024)",expected:"True\n"},
    ];
    for(const item of cases){
      const result=await executeIsolatedPython({sandbox,source:item.source,inputDirectory:"/home/user/workspace/probe-inputs",...('wallMs' in item?{wallMs:item.wallMs}:{}),...('outputBytes' in item?{outputBytes:item.outputBytes}:{})});
      const passed=('termination' in item?result.termination===item.termination:result.termination==="exit"&&result.exitCode===0&&result.stdout===item.expected)&&result.cleanupConfirmed;
      (report.cases as unknown[]).push({name:item.name,passed,result:{...result,stdout:result.stdout.length>512?`[${Buffer.byteLength(result.stdout)} output bytes]`:result.stdout}});
      if(!passed){process.exitCode=1;break;}
    }
    if(!process.exitCode){
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),1000);
      const result=await executeIsolatedPython({sandbox,source:"while True: pass",inputDirectory:"/home/user/workspace/probe-inputs",wallMs:10000,signal:controller.signal}).finally(()=>clearTimeout(timer));
      const passed=result.termination==='cancelled'&&result.cleanupConfirmed;
      (report.cases as unknown[]).push({name:'cancel',passed,result});if(!passed)process.exitCode=1;
    }
    if(!process.exitCode){
      let folder='';
      const running=executeIsolatedPython({sandbox,source:"import time\ntime.sleep(8)\nprint('UNEXPECTED_SURVIVAL')",inputDirectory:"/home/user/workspace/probe-inputs",wallMs:10000,onPrepared:value=>{folder=value;}}).then(()=>({failed:false}),()=>({failed:true}));
      let state:Record<string,any>|undefined;
      for(let attempt=0;attempt<30&&!state;attempt++){
        if(folder){
          const p=await sandbox.commands.run(`/usr/local/bin/python3 -I -S -c "import pathlib; p=pathlib.Path('${folder}/state.json'); print(p.read_text() if p.exists() else '{}')"`,{timeoutMs:2000});
          if(p.exitCode===0){const value=JSON.parse(p.stdout);if(value.hostPid)state=value;}
        }
        if(!state)await new Promise(resolve=>setTimeout(resolve,100));
      }
      if(!state)throw new Error('supervisor_state_missing');
      await sandbox.commands.run(`/usr/local/bin/python3 -I -S -c "import os,signal; os.kill(${Number(state.supervisorPid)},signal.SIGKILL)"`,{timeoutMs:2000});
      const outcome=await running;
      const checked=await sandbox.commands.run(`/usr/local/bin/python3 -I -S -c "import time,pathlib,json; time.sleep(1); p=pathlib.Path('/proc/${Number(state.hostPid)}/stat'); f=p.read_text().rsplit(')',1)[1].split() if p.exists() else []; print(json.dumps({'stopped':not f or f[0] in ['Z','X'] or f[19]!='${state.startTicks}'}))"`,{timeoutMs:3000});
      const stopped=checked.exitCode===0&&JSON.parse(checked.stdout).stopped===true;
      (report.cases as unknown[]).push({name:'supervisor_crash',passed:outcome.failed&&stopped,transportFailed:outcome.failed,childStopped:stopped});
      if(!outcome.failed||!stopped)process.exitCode=1;
    }
  }catch(error){report.errorCode=error instanceof IsolatedPythonExecutionError?error.code:"probe_failed";process.exitCode=1;}
  finally{
    let deleted=false;for(let n=0;sandbox&&!deleted&&n<3;n++){try{await sandbox.kill();deleted=true;}catch{}}
    report.deleted=deleted;report.finishedAt=new Date().toISOString();if(!deleted)process.exitCode=1;
    await writeFile(privatePath,JSON.stringify({runId,sandboxId:sandbox?.sandboxId,cleanup:deleted?"deleted":"needs_reconciliation"}),{mode:0o600});
    const out=resolve(root,"reports/agent-remediation/20260929-d04b");await mkdir(out,{recursive:true});await writeFile(resolve(out,label+'.json'),JSON.stringify(report,null,2)+'\n');process.stdout.write(JSON.stringify(report)+'\n');
  }
}
main().catch(()=>{process.stderr.write("isolated_python_probe_setup_failed\n");process.exitCode=1;});
