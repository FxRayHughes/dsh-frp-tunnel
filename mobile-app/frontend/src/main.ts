import { ProfileService } from "../bindings/dshmobile";
import type { Profile } from "../bindings/dshmobile/models";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const settings = $<HTMLFormElement>("settings");
const connecting = $<HTMLElement>("connecting");
const connectingText = $<HTMLElement>("connecting-text");
const server = $<HTMLInputElement>("server");
const user = $<HTMLInputElement>("user");
const password = $<HTMLInputElement>("password");
const auto = $<HTMLInputElement>("auto");
const status = $<HTMLElement>("status");
const testBtn = $<HTMLButtonElement>("test");
const connectBtn = $<HTMLButtonElement>("connect");
const login = $<HTMLFormElement>("login");

// `?manual` lets a return from the remote UI land here without auto-connecting.
const manual = new URLSearchParams(location.search).has("manual");
let cancelled = false;

function show(message: string, tone: "" | "ok" | "err" = "") {
  status.textContent = message;
  status.className = `status ${tone}`;
}

function busy(on: boolean) {
  testBtn.disabled = on;
  connectBtn.disabled = on;
}

function current(): Profile {
  return {
    server: server.value.trim(),
    user: user.value.trim(),
    password: password.value,
    autoConnect: auto.checked,
  } as Profile;
}

function showForm() {
  connecting.hidden = true;
  settings.hidden = false;
}

async function connect(profile: Profile, fromAuto: boolean) {
  cancelled = false;
  busy(true);
  if (fromAuto) {
    settings.hidden = true;
    connecting.hidden = false;
    connectingText.textContent = `正在连接 ${profile.server.replace(/^https?:\/\//, "")}…`;
  } else {
    show("正在连接…");
  }
  try {
    const result = await ProfileService.Test(profile);
    if (cancelled) return;
    if (!result.ok) {
      showForm();
      show(result.message, "err");
      return;
    }
    const saved = await ProfileService.Save(profile);
    if (cancelled) return;
    // Hand the credentials to the relay with a real navigation so the WebView
    // follows the 303 into DSH and keeps every cookie it sets.
    login.action = result.loginUrl;
    (login.elements.namedItem("user") as HTMLInputElement).value = saved.user;
    (login.elements.namedItem("password") as HTMLInputElement).value = saved.password;
    connectingText.textContent = "登录成功，正在打开 DSH…";
    settings.hidden = true;
    connecting.hidden = false;
    login.submit();
  } catch (error) {
    showForm();
    show(error instanceof Error ? error.message : String(error), "err");
  } finally {
    busy(false);
  }
}

settings.addEventListener("submit", (event) => {
  event.preventDefault();
  void connect(current(), false);
});

testBtn.addEventListener("click", async () => {
  busy(true);
  show("正在测试…");
  try {
    const result = await ProfileService.Test(current());
    show(result.message, result.ok ? "ok" : "err");
  } catch (error) {
    show(error instanceof Error ? error.message : String(error), "err");
  } finally {
    busy(false);
  }
});

$<HTMLButtonElement>("reveal").addEventListener("click", () => {
  password.type = password.type === "password" ? "text" : "password";
});

$<HTMLButtonElement>("cancel").addEventListener("click", () => {
  cancelled = true;
  showForm();
  show("");
});

$<HTMLButtonElement>("forget").addEventListener("click", async () => {
  await ProfileService.Forget();
  const fresh = await ProfileService.Load();
  server.value = fresh.server;
  user.value = fresh.user;
  password.value = "";
  auto.checked = fresh.autoConnect;
  show("已清除", "ok");
});

async function boot() {
  const profile = await ProfileService.Load();
  server.value = profile.server;
  user.value = profile.user;
  password.value = profile.password;
  auto.checked = profile.autoConnect;
  if (new URLSearchParams(location.search).get("reason") === "offline") {
    show("连接中断：服务器或电脑端 DSH 不可达，请检查后重试", "err");
  }
  if (!manual && profile.autoConnect && profile.server && profile.user && profile.password) {
    await connect(profile, true);
  }
}

void boot();
