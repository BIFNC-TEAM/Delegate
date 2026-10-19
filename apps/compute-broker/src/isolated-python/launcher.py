"""Trusted supervisor for the restricted single-process Python profile.

Never accept arbitrary mounts, executables, environment, limits or syscalls from
an Agent. The host supplies only source, a scoped input directory and bounded
wall/output limits. No normal-execution fallback is permitted on setup failure.
"""
import argparse
import base64
import ctypes
import errno
import json
import math
import os
import pathlib
import resource
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import sysconfig
import tempfile
import time

VERSION = "delegate.aio.single-python.v1"
MAX_SOURCE = 64 * 1024
MAX_INPUT = 32 * 1024 * 1024
MAX_OUTPUT = 64 * 1024
MAX_WALL_MS = 30_000
MEMORY_BYTES = 256 * 1024 * 1024
ENV = {"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": "/tmp", "TMPDIR": "/tmp", "LD_LIBRARY_PATH": "/usr/local/lib:/lib/x86_64-linux-gnu:/usr/lib/x86_64-linux-gnu"}
LIBC = ctypes.CDLL(None, use_errno=True)


def fail(code):
    raise RuntimeError(code)


def mount(source, target, kind=None, flags=0, data=None):
    encode = lambda value: value.encode() if value is not None else None
    LIBC.mount.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_ulong, ctypes.c_char_p]
    if LIBC.mount(encode(source), encode(str(target)), encode(kind), flags, encode(data)) != 0:
        fail("mount_failed_errno_" + str(ctypes.get_errno()))


def bind_readonly(source, target, executable=False):
    source = pathlib.Path(source)
    if not source.exists():
        fail("runtime_file_missing")
    if source.is_dir():
        target.mkdir(parents=True, exist_ok=True)
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.touch()
    mount(str(source), target, flags=4096)  # MS_BIND
    mount(None, target, flags=4096 | 32 | 1 | 2 | 4 | (0 if executable else 8))


def validate_inputs(path):
    root = pathlib.Path(path)
    if root.is_symlink() or not root.is_dir() or not str(root.resolve()).startswith("/home/user/workspace/"):
        fail("input_scope_invalid")
    total = 0
    count = 0
    for entry in root.iterdir():
        info = entry.lstat()
        if not stat.S_ISREG(info.st_mode) or entry.is_symlink():
            fail("input_type_invalid")
        total += info.st_size
        count += 1
        if total > MAX_INPUT or count > 32:
            fail("input_limit_exceeded")
    return root.resolve()


def secure_process():
    # Linux securebits lock root's exec-time capability special cases away.
    # https://man7.org/linux/man-pages/man7/capabilities.7.html
    if LIBC.prctl(28, 1 | 2 | 4 | 8 | 64 | 128, 0, 0, 0) != 0:
        fail("securebits_failed")
    for cap in range(64):
        if LIBC.prctl(24, cap, 0, 0, 0) != 0 and ctypes.get_errno() != errno.EINVAL:
            fail("capability_bound_failed")
    class Header(ctypes.Structure):
        _fields_ = [("version", ctypes.c_uint), ("pid", ctypes.c_int)]
    class Data(ctypes.Structure):
        _fields_ = [("effective", ctypes.c_uint), ("permitted", ctypes.c_uint), ("inheritable", ctypes.c_uint)]
    header = Header(0x20080522, 0)
    data = (Data * 2)()
    if LIBC.capset(ctypes.byref(header), ctypes.byref(data)) != 0:
        fail("capability_clear_failed")
    if LIBC.prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS
        fail("no_new_privs_failed")
    if LIBC.prctl(4, 0, 0, 0, 0) != 0:  # PR_SET_DUMPABLE
        fail("dumpability_failed")


def load_filter(lib):
    # Allowlist is intentionally single-process and has no socket, clone/fork,
    # namespace, mount, ptrace, io_uring, BPF, keyring or SysV IPC operations.
    names = """read write open openat close fstat newfstatat stat lstat statx lseek
      pread64 pwrite64 readv writev fcntl ioctl dup dup2 dup3 readlink readlinkat
      getdents64 access faccessat faccessat2 mmap mprotect munmap mremap madvise brk
      rt_sigaction rt_sigprocmask rt_sigreturn sigaltstack restart_syscall
      getpid getppid gettid getuid geteuid getgid getegid getgroups getresuid getresgid
      getrandom clock_gettime clock_getres clock_nanosleep nanosleep gettimeofday times
      uname sysinfo getcwd chdir fchdir umask mkdir mkdirat unlink unlinkat rmdir
      rename renameat renameat2 chmod fchmod fchmodat ftruncate truncate fsync fdatasync
      statfs fstatfs utimensat utimes link linkat symlink symlinkat sendfile copy_file_range
      poll ppoll select pselect6 epoll_create epoll_create1 epoll_ctl epoll_wait epoll_pwait
      futex set_tid_address set_robust_list rseq arch_prctl prlimit64 getrlimit setrlimit
      getrusage sched_yield sched_getaffinity sched_getparam sched_getscheduler
      sched_get_priority_max sched_get_priority_min getcpu capget execve exit exit_group""".split()
    lib.seccomp_init.argtypes = [ctypes.c_uint32]
    lib.seccomp_init.restype = ctypes.c_void_p
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    lib.seccomp_syscall_resolve_name.restype = ctypes.c_int
    lib.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    lib.seccomp_load.argtypes = [ctypes.c_void_p]
    lib.seccomp_release.argtypes = [ctypes.c_void_p]
    ctx = lib.seccomp_init(0x00050000 | errno.EPERM)
    if not ctx:
        fail("seccomp_init_failed")
    try:
        for name in names:
            number = lib.seccomp_syscall_resolve_name(name.encode())
            if number >= 0 and lib.seccomp_rule_add(ctx, 0x7FFF0000, number, 0) != 0:
                fail("seccomp_rule_failed")
        if lib.seccomp_load(ctx) != 0:
            fail("seccomp_load_failed")
    finally:
        lib.seccomp_release(ctx)


def inner(config, control_fd, admit_fd):
    # The unshare child is PID 1. Killing it also kills every descendant in this
    # PID namespace, even one which detached from the original process group.
    # https://man7.org/linux/man-pages/man7/pid_namespaces.7.html
    if os.getpid() != 1 or os.uname().machine != "x86_64":
        fail("namespace_profile_mismatch")
    pid_ns = os.readlink("/proc/self/ns/pid")
    net_ns = os.readlink("/proc/self/ns/net")
    process_stat = pathlib.Path("/proc/self/stat").read_text()
    host_pid = int(process_stat.split(" ", 1)[0])
    start_ticks = process_stat.rsplit(")", 1)[1].split()[19]
    seccomp = ctypes.CDLL("libseccomp.so.2", use_errno=True)
    hostname = b"delegate-code"
    if LIBC.sethostname(hostname, len(hostname)) != 0:
        fail("hostname_isolation_failed")
    mount(None, "/", flags=(1 << 18) | 16384)  # recursively private
    root = pathlib.Path(config["root"])
    mount("tmpfs", root, "tmpfs", 2 | 4, "size=16m,nr_inodes=1024,mode=0755")
    for directory in ["usr/local/bin", "usr/local/lib", "lib", "lib64", "workspace", "tmp", "dev"]:
        (root / directory).mkdir(parents=True, exist_ok=True)
    binary = pathlib.Path(sys.executable).resolve()
    stdlib = pathlib.Path(sysconfig.get_path("stdlib")).resolve()
    if not str(binary).startswith("/usr/local/bin/python") or not str(stdlib).startswith("/usr/local/lib/python"):
        fail("python_layout_unsupported")
    bind_readonly(binary, root / str(binary).lstrip("/"), executable=True)
    bind_readonly(stdlib, root / str(stdlib).lstrip("/"), executable=True)
    for name in ["site-packages", "dist-packages"]:
        target = root / str(stdlib).lstrip("/") / name
        if target.exists():
            mount("tmpfs", target, "tmpfs", 1 | 2 | 4 | 8, "size=4k,nr_inodes=1,mode=0555")
    for library in pathlib.Path("/usr/local/lib").glob("libpython*.so*"):
        bind_readonly(library.resolve(), root / str(library).lstrip("/"), executable=True)
    for source, target in [("/lib/x86_64-linux-gnu", "lib/x86_64-linux-gnu"), ("/usr/lib/x86_64-linux-gnu", "usr/lib/x86_64-linux-gnu")]:
        if pathlib.Path(source).is_dir():
            bind_readonly(pathlib.Path(source).resolve(), root / target, executable=True)
    bind_readonly(pathlib.Path("/lib64/ld-linux-x86-64.so.2").resolve(), root / "lib64/ld-linux-x86-64.so.2", executable=True)
    for device in ["null", "zero", "urandom", "random"]:
        target = root / "dev" / device
        target.touch()
        mount("/dev/" + device, target, flags=4096)
    mount("tmpfs", root / "workspace", "tmpfs", 2 | 4 | 8, "size=64m,nr_inodes=4096,mode=0700")
    (root / "workspace/inputs").mkdir()
    (root / "workspace/outputs").mkdir()
    bind_readonly(config["inputs"], root / "workspace/inputs")
    mount("tmpfs", root / "tmp", "tmpfs", 2 | 4 | 8, "size=16m,nr_inodes=1024,mode=0700")
    bind_readonly(config["program"], root / "program.py")
    mount(None, root, flags=32 | 1 | 2 | 4)
    os.chroot(root)
    os.chdir("/workspace")
    resource.setrlimit(resource.RLIMIT_AS, (MEMORY_BYTES, MEMORY_BYTES))
    resource.setrlimit(resource.RLIMIT_CPU, (math.ceil(config["wallMs"] / 1000) + 1,) * 2)
    resource.setrlimit(resource.RLIMIT_FSIZE, (8 * 1024 * 1024,) * 2)
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    resource.setrlimit(resource.RLIMIT_NPROC, (1, 1))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    secure_process()
    load_filter(seccomp)
    os.write(control_fd, (json.dumps({"ready": True, "pidNamespace": pid_ns, "netNamespace": net_ns, "hostPid": host_pid, "startTicks": start_ticks}) + "\n").encode())
    os.close(control_fd)
    # The supervisor must record the child identity and check cancellation
    # before user code can start. User stdout cannot race the ready receipt.
    if os.read(admit_fd, 1) != b"G":
        fail("execution_not_admitted")
    os.close(admit_fd)
    os.execve(str(binary), [str(binary), "-I", "-S", "-B", "/program.py"], ENV)


def supervise(source, inputs, wall_ms, output_bytes, cancel_file=None, state_file=None):
    source_bytes = source.encode("utf-8")
    if not source_bytes or len(source_bytes) > MAX_SOURCE:
        fail("source_limit_exceeded")
    inputs = validate_inputs(inputs)
    if not (100 <= wall_ms <= MAX_WALL_MS and 1 <= output_bytes <= MAX_OUTPUT):
        fail("limit_invalid")
    # /proc must use this supervisor's PID view for cleanup identity checks.
    if int(pathlib.Path('/proc/self/stat').read_text().split(' ', 1)[0]) != os.getpid():
        fail("supervisor_pid_view_invalid")
    started = time.monotonic()
    result = {"profile": VERSION, "termination": "setup_failed", "exitCode": None, "stdout": "", "stderr": "", "cleanupConfirmed": False}
    with tempfile.TemporaryDirectory(prefix="delegate-code-") as stage:
        stage = pathlib.Path(stage)
        (stage / "root").mkdir()
        (stage / "program.py").write_bytes(source_bytes)
        config = {"root": str(stage / "root"), "program": str(stage / "program.py"), "inputs": str(inputs), "wallMs": wall_ms}
        config_path = stage / "config.json"
        config_path.write_text(json.dumps(config))
        control_read, control_write = os.pipe()
        admit_read, admit_write = os.pipe()
        process = None
        ready_at = None
        child_receipt = None
        buffers = {"stdout": bytearray(), "stderr": bytearray(), "control": bytearray()}
        selector = selectors.DefaultSelector()
        try:
            if cancel_file and pathlib.Path(cancel_file).exists():
                result.update(termination="cancelled", cleanupConfirmed=True)
                return result
            supervisor_pid = os.getpid()
            def guard_parent():
                if LIBC.prctl(1, signal.SIGKILL, 0, 0, 0) != 0 or os.getppid() != supervisor_pid:
                    os._exit(125)
            process = subprocess.Popen(["/usr/bin/unshare", "--user", "--map-root-user", "--mount", "--net", "--pid", "--fork", "--ipc", "--uts", "--kill-child=KILL",
                sys.executable, "-I", "-S", __file__, "--inner", str(config_path), str(control_write), str(admit_read)], stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, pass_fds=(control_write, admit_read), start_new_session=True, preexec_fn=guard_parent, env=ENV)
            os.close(control_write)
            control_write = None
            os.close(admit_read)
            admit_read = None
            for descriptor, name in [(process.stdout.fileno(), "stdout"), (process.stderr.fileno(), "stderr"), (control_read, "control")]:
                os.set_blocking(descriptor, False)
                selector.register(descriptor, selectors.EVENT_READ, name)
            while selector.get_map() or process.poll() is None:
                now = time.monotonic()
                if cancel_file and pathlib.Path(cancel_file).exists():
                    result["termination"] = "cancelled"
                    break
                if now - started > 10 + wall_ms / 1000 or (ready_at and now - ready_at > wall_ms / 1000):
                    result["termination"] = "command_timeout" if ready_at else "setup_timeout"
                    break
                for key, _ in selector.select(0.02):
                    chunk = os.read(key.fd, 8192)
                    if not chunk:
                        selector.unregister(key.fd)
                        continue
                    name = key.data
                    maximum = 4096 if name == "control" else output_bytes
                    if len(buffers[name]) + len(chunk) > maximum:
                        buffers[name].extend(chunk[:max(0, maximum - len(buffers[name]))])
                        result["termination"] = "output_limit" if name != "control" else "setup_failed"
                        break
                    buffers[name].extend(chunk)
                    if name == "control" and b"\n" in buffers[name] and ready_at is None:
                        receipt = json.loads(buffers[name].decode())
                        if receipt.get("ready") is not True:
                            result["setupError"] = receipt.get("error", "isolation_setup_failed")
                            break
                        result["namespace"] = receipt
                        child_receipt = receipt
                        if state_file:
                            pathlib.Path(state_file).write_text(json.dumps({"supervisorPid": supervisor_pid, "unsharePid": process.pid, **receipt}))
                        ready_at = time.monotonic()
                        if cancel_file and pathlib.Path(cancel_file).exists():
                            result["termination"] = "cancelled"
                            break
                        os.write(admit_write, b"G")
                        os.close(admit_write)
                        admit_write = None
                if result["termination"] in ["output_limit", "cancelled"] or result.get("setupError"):
                    break
            if ready_at and process.poll() is not None and result["termination"] == "setup_failed":
                result["termination"] = "exit"
                result["exitCode"] = process.returncode
        finally:
            if control_write is not None:
                os.close(control_write)
            if admit_read is not None:
                os.close(admit_read)
            if admit_write is not None:
                os.close(admit_write)
            if process is not None:
                # Kills the unshare supervisor. --kill-child kills namespace PID1.
                # No user process can fork or create another process/session.
                if process.poll() is None:
                    try: os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError: pass
                try:
                    process.wait(timeout=3)
                    deadline = time.monotonic() + 2
                    while True:
                        stopped = child_receipt is None
                        if child_receipt:
                            try:
                                fields = pathlib.Path('/proc/' + str(child_receipt['hostPid']) + '/stat').read_text().rsplit(')', 1)[1].split()
                                stopped = fields[0] in ['Z', 'X'] or fields[19] != child_receipt['startTicks']
                            except FileNotFoundError: stopped = True
                            except OSError: stopped = False
                        if stopped or time.monotonic() >= deadline:
                            result["cleanupConfirmed"] = stopped
                            if not stopped:
                                result["termination"] = "cleanup_unconfirmed"
                                result["exitCode"] = None
                            break
                        time.sleep(0.01)
                except subprocess.TimeoutExpired:
                    result["termination"] = "cleanup_unconfirmed"
                    result["exitCode"] = None
            selector.close()
            os.close(control_read)
            if process is not None:
                process.stdout.close()
                process.stderr.close()
        if ready_at:
            try:
                result["stdout"] = bytes(buffers["stdout"]).decode("utf-8")
                result["stderr"] = bytes(buffers["stderr"]).decode("utf-8")
            except UnicodeDecodeError:
                result.update(termination="invalid_output", exitCode=None, stdout="", stderr="")
        else:
            # Bootstrap diagnostics are codes only, never host paths/environment.
            result.setdefault("setupError", "isolation_setup_failed")
        result["wallMs"] = round((time.monotonic() - started) * 1000)
        return result


def main():
    if sys.argv[1:2] == ["--inner"]:
        try:
            inner(json.loads(pathlib.Path(sys.argv[2]).read_text()), int(sys.argv[3]), int(sys.argv[4]))
        except Exception as error:
            code = str(error) if isinstance(error, RuntimeError) else "bootstrap_error"
            try: os.write(int(sys.argv[3]), (json.dumps({"ready": False, "error": code}) + "\n").encode())
            except OSError: pass
            os._exit(125)
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-base64", required=True)
    parser.add_argument("--inputs", required=True)
    parser.add_argument("--wall-ms", type=int, default=5000)
    parser.add_argument("--output-bytes", type=int, default=65536)
    parser.add_argument("--cancel-file")
    parser.add_argument("--state-file")
    args = parser.parse_args()
    try:
        source = base64.b64decode(args.source_base64, validate=True).decode("utf-8")
        result = supervise(source, args.inputs, args.wall_ms, args.output_bytes, args.cancel_file, args.state_file)
    except Exception as error:
        result = {"profile": VERSION, "termination": "setup_failed", "exitCode": None, "stdout": "", "stderr": "", "setupError": str(error) if isinstance(error, RuntimeError) else "input_or_setup_invalid", "cleanupConfirmed": False}
    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    main()
