import type { BrowserTransportKind } from "@delegate/compute-protocol";

export type NativeBrowserAction =
  | {
      type: "click";
      button?: "left" | "right" | "middle" | "wheel" | "back" | "forward";
      x?: number;
      y?: number;
    }
  | {
      type: "double_click";
      x?: number;
      y?: number;
    }
  | {
      type: "drag";
      path: Array<{
        x: number;
        y: number;
      }>;
    }
  | {
      type: "keypress";
      keys: string[];
    }
  | {
      type: "move";
      x: number;
      y: number;
    }
  | {
      type: "screenshot";
    }
  | {
      type: "scroll";
      scroll_x: number;
      scroll_y: number;
      x?: number;
      y?: number;
    }
  | {
      type: "type";
      text: string;
    }
  | {
      type: "wait";
      durationMs?: number;
    };

export type PlaywrightBrowseArtifactPayload = {
  transportKind: BrowserTransportKind;
  profilePath: string;
  title: string;
  finalUrl: string;
  textSnippet: string;
  contentSnippet: string;
  links: Array<{
    text: string;
    href: string;
  }>;
  screenshotBase64: string;
  screenshotMimeType: "image/png" | "image/jpeg";
  executedActions?: Array<{
    type: NativeBrowserAction["type"];
    summary: string;
  }>;
};

export function buildPlaywrightBrowseCommand(params: {
  url: string;
  playwrightVersion: string;
}): string {
  const script = buildBasePlaywrightScript({
    transportKind: "playwright",
    playwrightVersion: params.playwrightVersion,
    scriptBody: [
      `  await page.goto(${JSON.stringify(params.url)}, { waitUntil: 'domcontentloaded', timeout: 15000 });`,
      "  await page.waitForTimeout(750);",
    ],
  });

  return buildPlaywrightCommand(script, params.playwrightVersion);
}

export function buildPlaywrightNativeCommand(params: {
  transportKind: Extract<BrowserTransportKind, "openai_computer" | "claude_computer_use">;
  playwrightVersion: string;
  actions: NativeBrowserAction[];
  currentUrl?: string | null | undefined;
}): string {
  const normalizedActions = params.actions.map((action) => ({
    ...action,
    ...(action.type === "keypress"
      ? {
          keys: action.keys.map((key) => normalizePlaywrightKey(key)),
        }
      : {}),
  }));
  const script = buildBasePlaywrightScript({
    transportKind: params.transportKind,
    playwrightVersion: params.playwrightVersion,
    scriptBody: [
      `  const requestedUrl = ${JSON.stringify(params.currentUrl ?? null)};`,
      "  if (requestedUrl && (!page.url() || page.url() === 'about:blank' || page.url() !== requestedUrl)) {",
      "    await page.goto(requestedUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => undefined);",
      "    await page.waitForTimeout(400);",
      "  }",
      "  let cursorX = 0;",
      "  let cursorY = 0;",
      `  const actions = ${JSON.stringify(normalizedActions)};`,
      "  const executedActions = [];",
      "  const pushAction = (type, summary) => executedActions.push({ type, summary });",
      "  for (const action of actions) {",
      "    switch (action.type) {",
      "      case 'move': {",
      "        cursorX = action.x;",
      "        cursorY = action.y;",
      "        await page.mouse.move(cursorX, cursorY);",
      "        pushAction('move', `move(${cursorX}, ${cursorY})`);",
      "        break;",
      "      }",
      "      case 'click': {",
      "        if (typeof action.x === 'number' && typeof action.y === 'number') {",
      "          cursorX = action.x;",
      "          cursorY = action.y;",
      "        }",
      "        await page.mouse.click(cursorX, cursorY, { button: action.button || 'left' });",
      "        pushAction('click', `${action.button || 'left'} click(${cursorX}, ${cursorY})`);",
      "        break;",
      "      }",
      "      case 'double_click': {",
      "        if (typeof action.x === 'number' && typeof action.y === 'number') {",
      "          cursorX = action.x;",
      "          cursorY = action.y;",
      "        }",
      "        await page.mouse.dblclick(cursorX, cursorY);",
      "        pushAction('double_click', `doubleClick(${cursorX}, ${cursorY})`);",
      "        break;",
      "      }",
      "      case 'drag': {",
      "        const [first, ...rest] = Array.isArray(action.path) ? action.path : [];",
      "        if (!first) {",
      "          throw new Error('drag path is empty');",
      "        }",
      "        cursorX = first.x;",
      "        cursorY = first.y;",
      "        await page.mouse.move(cursorX, cursorY);",
      "        await page.mouse.down();",
      "        for (const point of rest) {",
      "          cursorX = point.x;",
      "          cursorY = point.y;",
      "          await page.mouse.move(cursorX, cursorY);",
      "        }",
      "        await page.mouse.up();",
      "        pushAction('drag', `drag(${action.path.length} points)`);",
      "        break;",
      "      }",
      "      case 'keypress': {",
      "        const shortcut = Array.isArray(action.keys) ? action.keys.join('+') : '';",
      "        if (!shortcut) {",
      "          throw new Error('keypress keys missing');",
      "        }",
      "        await page.keyboard.press(shortcut);",
      "        pushAction('keypress', shortcut);",
      "        break;",
      "      }",
      "      case 'scroll': {",
      "        if (typeof action.x === 'number' && typeof action.y === 'number') {",
      "          cursorX = action.x;",
      "          cursorY = action.y;",
      "          await page.mouse.move(cursorX, cursorY);",
      "        }",
      "        await page.mouse.wheel(action.scroll_x || 0, action.scroll_y || 0);",
      "        pushAction('scroll', `scroll(${action.scroll_x || 0}, ${action.scroll_y || 0})`);",
      "        break;",
      "      }",
      "      case 'type': {",
      "        await page.keyboard.type(action.text || '');",
      "        pushAction('type', (action.text || '').slice(0, 80));",
      "        break;",
      "      }",
      "      case 'wait': {",
      "        const duration = typeof action.durationMs === 'number' ? Math.max(250, Math.min(action.durationMs, 5000)) : 1000;",
      "        await page.waitForTimeout(duration);",
      "        pushAction('wait', `${duration}ms`);",
      "        break;",
      "      }",
      "      case 'screenshot': {",
      "        pushAction('screenshot', 'capture');",
      "        break;",
      "      }",
      "      default:",
      "        throw new Error(`Unsupported native action: ${String(action.type)}`);",
      "    }",
      "    await page.waitForTimeout(350);",
      "  }",
      "  globalThis.__delegateExecutedActions = executedActions;",
    ],
  });

  return buildPlaywrightCommand(script, params.playwrightVersion);
}

export function buildOpenCodeComputerUseCommand(params: {
  opencodeCommand: string;
  model?: string | null | undefined;
  playwrightVersion: string;
  task: string;
  maxSteps: number;
  allowMutations: boolean;
  currentUrl?: string | null | undefined;
  currentTitle?: string | null | undefined;
  textSnippet?: string | null | undefined;
  screenshotBase64: string;
  screenshotMimeType: "image/png" | "image/jpeg";
}): string {
  const command = params.opencodeCommand.trim() || "opencode";
  const shouldBootstrapOpenCode = command === "opencode";
  const modelArg =
    params.model && params.model !== "opencode/default" ? ` --model ${shellQuote(params.model)}` : "";
  const taskMarkdown = [
    "# Delegate OpenCode Browser Task",
    "",
    "You are running inside a Daytona VM sandbox. Use the local browser helper when you need to inspect or operate the retained browser session.",
    "",
    `Task: ${params.task}`,
    "",
    `Current URL: ${params.currentUrl ?? "unknown"}`,
    `Current title: ${params.currentTitle ?? "unknown"}`,
    `Mutation approval: ${params.allowMutations ? "allowed" : "not allowed"}`,
    `Maximum browser action rounds: ${params.maxSteps}`,
    "",
    "Helpful commands:",
    "- `node delegate-browser-tool.cjs inspect` prints the current browser state and captures a fresh screenshot.",
    "- `node delegate-browser-tool.cjs actions '[{\"type\":\"click\",\"x\":100,\"y\":120}]'` executes approved browser actions when mutation approval is enabled.",
    "",
    "Use only the retained browser profile at `$DELEGATE_SESSION_ROOT/browser-profile`. Do not create unrelated browser profiles. If mutation approval is not allowed, inspect only and do not click, type, submit, or navigate.",
    "",
    "Relevant page text:",
    params.textSnippet ?? "",
  ].join("\n");
  const helperScript = buildOpenCodeBrowserHelperScript(params);
  return [
    "set -euo pipefail",
    "export DELEGATE_SESSION_ROOT=${DELEGATE_SESSION_ROOT:-/workspace}",
    "WORKDIR=\"$DELEGATE_SESSION_ROOT/opencode-computer-use\"",
    "mkdir -p \"$WORKDIR\" /tmp/npm-cache",
    "cd \"$WORKDIR\"",
    "[ -f package.json ] || npm init -y >/dev/null 2>&1",
    `HOME=/tmp npm_config_cache=/tmp/npm-cache PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npm install --silent --no-save playwright@${params.playwrightVersion} >/dev/null 2>&1`,
    `cat > delegate-browser-tool.cjs <<'DELEGATE_OPENCODE_HELPER'\n${helperScript}\nDELEGATE_OPENCODE_HELPER`,
    `printf '%s' ${shellQuote(taskMarkdown)} > TASK.md`,
    `printf '%s' ${shellQuote(params.screenshotBase64)} > seed-screenshot.${params.screenshotMimeType === "image/png" ? "png" : "jpg"}.base64`,
    `OPENCODE_BIN=${shellQuote(command)}`,
    "if ! command -v \"$OPENCODE_BIN\" >/dev/null 2>&1; then",
    shouldBootstrapOpenCode
      ? "  HOME=/tmp npm_config_cache=/tmp/npm-cache npm install --silent --no-save opencode-ai >/dev/null 2>&1 && OPENCODE_BIN=./node_modules/.bin/opencode"
      : `  echo "OpenCode CLI not found in Daytona sandbox: ${command}" >&2; exit 127`,
    "fi",
    `"$OPENCODE_BIN" run --auto${modelArg} "$(cat TASK.md)" > opencode.stdout 2> opencode.stderr`,
  ].join("\n");
}

export function buildOpenCodeCaptureCommand(): string {
  return [
    "set -euo pipefail",
    "export DELEGATE_SESSION_ROOT=${DELEGATE_SESSION_ROOT:-/workspace}",
    'WORKDIR="$DELEGATE_SESSION_ROOT/opencode-computer-use"',
    'cd "$WORKDIR"',
    "HOME=/tmp PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright node delegate-browser-tool.cjs inspect",
  ].join("\n");
}

export function parsePlaywrightBrowseArtifactPayload(stdout: string): PlaywrightBrowseArtifactPayload | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (
      !isBrowserTransportKind(parsed.transportKind) ||
      typeof parsed.profilePath !== "string" ||
      typeof parsed.title !== "string" ||
      typeof parsed.finalUrl !== "string" ||
      typeof parsed.textSnippet !== "string" ||
      typeof parsed.contentSnippet !== "string" ||
      typeof parsed.screenshotBase64 !== "string" ||
      (parsed.screenshotMimeType !== "image/png" && parsed.screenshotMimeType !== "image/jpeg") ||
      !Array.isArray(parsed.links)
    ) {
      return null;
    }

    const links = parsed.links
      .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object")
      .map((value) => ({
        text: typeof value.text === "string" ? value.text : "",
        href: typeof value.href === "string" ? value.href : "",
      }))
      .filter((value) => value.href.length > 0)
      .slice(0, 12);

    const executedActions = Array.isArray(parsed.executedActions)
      ? parsed.executedActions
          .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object")
          .map((value) => ({
            type: isNativeActionType(value.type) ? value.type : "screenshot",
            summary: typeof value.summary === "string" ? value.summary : "",
          }))
      : undefined;

    return {
      transportKind: parsed.transportKind,
      profilePath: parsed.profilePath,
      title: parsed.title,
      finalUrl: parsed.finalUrl,
      textSnippet: parsed.textSnippet,
      contentSnippet: parsed.contentSnippet,
      links,
      screenshotBase64: parsed.screenshotBase64,
      screenshotMimeType: parsed.screenshotMimeType,
      ...(executedActions?.length ? { executedActions } : {}),
    };
  } catch {
    return null;
  }
}

function buildPlaywrightCommand(script: string, playwrightVersion: string) {
  return [
    "mkdir -p /tmp/pw-run",
    "mkdir -p /tmp/npm-cache",
    "cd /tmp/pw-run",
    "[ -f package.json ] || npm init -y >/dev/null 2>&1",
    `HOME=/tmp npm_config_cache=/tmp/npm-cache PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npm install --silent --no-save playwright@${playwrightVersion} >/dev/null 2>&1`,
    `HOME=/tmp PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright node -e ${shellQuote(script)}`,
  ].join("\n");
}

function buildOpenCodeBrowserHelperScript(params: {
  allowMutations: boolean;
  currentUrl?: string | null | undefined;
}) {
  return [
    "const {chromium}=require('playwright');",
    "const fs=require('node:fs/promises');",
    "const norm=(v)=>String(v||'').replace(/\\s+/g,' ').trim();",
    `const requestedUrl=${JSON.stringify(params.currentUrl ?? null)};`,
    `const allowMutations=${JSON.stringify(params.allowMutations)};`,
    "void(async()=>{",
    "const root=process.env.DELEGATE_SESSION_ROOT||'/workspace';",
    "const profilePath=`${root}/browser-profile`;",
    "await fs.mkdir(profilePath,{recursive:true});",
    "const context=await chromium.launchPersistentContext(profilePath,{headless:true,viewport:{width:1440,height:960},args:['--no-sandbox','--disable-dev-shm-usage']});",
    "const page=context.pages()[0]||await context.newPage();",
    "if(requestedUrl&&(!page.url()||page.url()==='about:blank')) await page.goto(requestedUrl,{waitUntil:'domcontentloaded',timeout:15000}).catch(()=>undefined);",
    "await page.waitForTimeout(400);",
    "const executedActions=[]; const push=(type,summary)=>executedActions.push({type,summary});",
    "if((process.argv[2]||'inspect')==='actions'){",
    "if(!allowMutations) throw new Error('Browser actions are disabled because this task was not approved for mutations. Use inspect only.');",
    "for(const action of JSON.parse(process.argv[3]||'[]')){",
    "if(action.type==='move'){await page.mouse.move(action.x,action.y);push('move',`move(${action.x}, ${action.y})`)}",
    "else if(action.type==='click'&&typeof action.x==='number'&&typeof action.y==='number'){await page.mouse.click(action.x,action.y,{button:action.button||'left'});push('click',`click(${action.x}, ${action.y})`)}",
    "else if(action.type==='type'){await page.keyboard.type(String(action.text||''));push('type',`type(${String(action.text||'').length} chars)`)}",
    "else if(action.type==='scroll'){await page.mouse.wheel(Number(action.scroll_x||0),Number(action.scroll_y||0));push('scroll',`scroll(${Number(action.scroll_x||0)}, ${Number(action.scroll_y||0)})`)}",
    "else if(action.type==='wait'){await page.waitForTimeout(Math.max(250,Math.min(Number(action.durationMs||1000),5000)));push('wait','wait')}",
    "else if(action.type==='screenshot'){push('screenshot','capture')}",
    "else throw new Error(`Unsupported OpenCode browser action: ${String(action.type)}`);",
    "await page.waitForTimeout(350);",
    "}} else push('screenshot','inspect');",
    "const title=await page.title().catch(()=>'');",
    "const finalUrl=page.url();",
    "const textSnippet=norm(await page.locator('body').innerText().catch(()=>'')).slice(0,2400);",
    "const contentSnippet=(await page.content()).slice(0,12000);",
    "const links=await page.locator('a[href]').evaluateAll(ns=>ns.slice(0,12).map(n=>({text:(n.textContent||'').trim().slice(0,120),href:n.href}))).catch(()=>[]);",
    "const raw=await page.screenshot({type:'jpeg',quality:65,fullPage:false,encoding:'base64'});",
    "const screenshotBase64=typeof raw==='string'?raw:raw.toString('base64');",
    "console.log(JSON.stringify({transportKind:'opencode_computer_use',profilePath,title,finalUrl,textSnippet,contentSnippet,links,screenshotBase64,screenshotMimeType:'image/jpeg',executedActions},null,2));",
    "await context.close();",
    "})().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1)});",
  ].join("\n");
}

function buildBasePlaywrightScript(params: {
  transportKind: BrowserTransportKind;
  playwrightVersion: string;
  scriptBody: string[];
}) {
  return [
    "const normalize = (value) => value.replace(/\\s+/g, ' ').trim();",
    "const { promises: fs } = require('node:fs');",
    "void (async () => {",
    "  const { chromium } = require('playwright');",
    "  const sessionRoot = process.env.DELEGATE_SESSION_ROOT || '/delegate-session';",
    "  const profilePath = `${sessionRoot}/browser-profile`;",
    "  await fs.mkdir(profilePath, { recursive: true });",
    "  const context = await chromium.launchPersistentContext(profilePath, {",
    "    headless: true,",
    "    viewport: { width: 1440, height: 960 },",
    "    args: ['--no-sandbox', '--disable-dev-shm-usage'],",
    "  });",
    "  const page = context.pages()[0] || (await context.newPage());",
    ...params.scriptBody,
    "  const title = await page.title().catch(() => '');",
    "  const finalUrl = page.url();",
    "  const textSnippet = normalize(await page.locator('body').innerText().catch(() => '')).slice(0, 2400);",
    "  const contentSnippet = (await page.content()).slice(0, 12000);",
    "  const links = await page.locator('a[href]').evaluateAll((nodes) => nodes.slice(0, 12).map((node) => ({ text: (node.textContent || '').trim().slice(0, 120), href: node.href }))).catch(() => []);",
    "  const screenshotRaw = await page.screenshot({ type: 'jpeg', quality: 65, fullPage: false, encoding: 'base64' });",
    "  const screenshotBase64 = typeof screenshotRaw === 'string' ? screenshotRaw : screenshotRaw.toString('base64');",
    `  console.log(JSON.stringify({ transportKind: ${JSON.stringify(params.transportKind)}, profilePath, title, finalUrl, textSnippet, contentSnippet, links, screenshotBase64, screenshotMimeType: 'image/jpeg', executedActions: globalThis.__delegateExecutedActions || [] }, null, 2));`,
    "  await context.close();",
    "})().catch((error) => {",
    "  console.error(error.stack || error.message || String(error));",
    "  process.exit(1);",
    "});",
  ].join("\n");
}

function normalizePlaywrightKey(value: string) {
  switch (value.toLowerCase()) {
    case "ctrl":
    case "control":
      return "Control";
    case "cmd":
    case "meta":
    case "command":
      return "Meta";
    case "alt":
    case "option":
      return "Alt";
    case "shift":
      return "Shift";
    case "enter":
    case "return":
      return "Enter";
    case "escape":
    case "esc":
      return "Escape";
    case "backspace":
      return "Backspace";
    case "delete":
    case "del":
      return "Delete";
    case "tab":
      return "Tab";
    case "space":
      return "Space";
    case "arrowup":
    case "up":
      return "ArrowUp";
    case "arrowdown":
    case "down":
      return "ArrowDown";
    case "arrowleft":
    case "left":
      return "ArrowLeft";
    case "arrowright":
    case "right":
      return "ArrowRight";
    default:
      return value.length === 1 ? value : value[0]?.toUpperCase() + value.slice(1);
  }
}

function isBrowserTransportKind(value: unknown): value is BrowserTransportKind {
  return (
    value === "playwright" ||
    value === "openai_computer" ||
    value === "claude_computer_use" ||
    value === "opencode_computer_use"
  );
}

function isNativeActionType(value: unknown): value is NativeBrowserAction["type"] {
  return (
    value === "click" ||
    value === "double_click" ||
    value === "drag" ||
    value === "keypress" ||
    value === "move" ||
    value === "screenshot" ||
    value === "scroll" ||
    value === "type" ||
    value === "wait"
  );
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}
