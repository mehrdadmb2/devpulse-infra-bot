const VERSION = "1.0.0";
const GH_API = "https://api.github.com";
const CF_API = "https://api.cloudflare.com/client/v4";
const TG_API = "https://api.telegram.org";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return json({ name: "DevPulse Infra Radar", version: VERSION, status: "ok", message: "Private Telegram bot webhook. Use /health for the health check." });
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ status: "ok", version: VERSION, configured: {
        telegram: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET && env.TELEGRAM_OWNER_ID),
        github: Boolean(env.GITHUB_TOKEN && env.GITHUB_USERNAME),
        cloudflare: Boolean(env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID),
        d1: Boolean(env.DB),
      } });
    }
    const expectedPath = `/tg/${env.TELEGRAM_WEBHOOK_SECRET || "__missing__"}`;
    if (url.pathname !== expectedPath || request.method !== "POST") {
      return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }
    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }
    // Respond to Telegram immediately; the actual handling continues on the Worker context.
    ctx.waitUntil(handleUpdate(update, env).catch((err) => console.error("update_handler_error", safeError(err))));
    return new Response("ok", { status: 200 });
  },
};

async function handleUpdate(update, env) {
  try {
    if (update.callback_query) {
      const cq = update.callback_query;
      const fromId = String(cq.from?.id ?? "");
      await answerCallback(env, cq.id).catch(() => {});
      if (!isOwner(fromId, env) || cq.message?.chat?.type !== "private") return;
      await audit(env, fromId, `callback:${String(cq.data || "unknown").slice(0, 60)}`);
      await routeCallback(cq, env);
      return;
    }
    const message = update.message;
    if (!message || message.chat?.type !== "private" || !message.from) return;
    const fromId = String(message.from.id);
    if (!isOwner(fromId, env)) return;
    const text = String(message.text || "").trim();
    if (!text) return;
    await audit(env, fromId, `message:${text.startsWith("/") ? text.split(/\s+/)[0].slice(0, 32) : "text"}`);
    if (/^\/(start|menu)(?:@\w+)?(?:\s|$)/i.test(text)) return showHome(env, message.chat.id);
    if (/^\/help(?:@\w+)?(?:\s|$)/i.test(text)) return sendHelp(env, message.chat.id);
    if (/^\/github(?:@\w+)?(?:\s|$)/i.test(text)) return showGitHub(env, message.chat.id);
    if (/^\/cloudflare(?:@\w+)?(?:\s|$)/i.test(text)) return showCloudflare(env, message.chat.id);
    const repoMatch = text.match(/^\/repo(?:@\w+)?\s+(.+)$/i);
    if (repoMatch) return showRepoByName(env, message.chat.id, repoMatch[1].trim());
    const workerMatch = text.match(/^\/worker(?:@\w+)?\s+(.+)$/i);
    if (workerMatch) return showWorkerByName(env, message.chat.id, workerMatch[1].trim());
    return tgSend(env, message.chat.id, "متوجه دستور نشدم. از منوی اصلی استفاده کن یا /help را بزن.", homeKeyboard());
  } catch (err) {
    console.error("handleUpdate_error", safeError(err));
    const chatId = update.callback_query?.message?.chat?.id ?? update.message?.chat?.id;
    if (chatId) await tgSend(env, chatId, `⚠️ <b>در پردازش درخواست خطا رخ داد</b>\n<blockquote>${html(shortError(err))}</blockquote>`, homeKeyboard()).catch(() => {});
  }
}

function isOwner(id, env) {
  return Boolean(env.TELEGRAM_OWNER_ID) && String(id) === String(env.TELEGRAM_OWNER_ID);
}

async function routeCallback(cq, env) {
  const data = String(cq.data || "");
  const chatId = cq.message.chat.id;
  const messageId = cq.message.message_id;
  const parts = data.split(":");
  const edit = async (text, keyboard) => tgEdit(env, chatId, messageId, text, keyboard);
  if (data === "home") return edit(homeText(env), homeKeyboard());
  if (data === "gh") return showGitHub(env, chatId, messageId);
  if (data === "cf") return showCloudflare(env, chatId, messageId);
  if (data === "gh:repos") return showRepos(env, chatId, 0, messageId);
  if (parts[0] === "ghrepos") return showRepos(env, chatId, clampPage(parts[1]), messageId);
  if (data === "gh:pages") return showPages(env, chatId, 0, messageId);
  if (parts[0] === "ghpages") return showPages(env, chatId, clampPage(parts[1]), messageId);
  if (data === "gh:events") return showGitHubEvents(env, chatId, messageId);
  if (data === "gh:overview") return showGitHub(env, chatId, messageId);
  if (data === "gh:links") return showGitHubLinks(env, chatId, messageId);
  if (data === "cf:workers") return showWorkers(env, chatId, 0, messageId);
  if (data === "cf:domains") return showWorkerDomains(env, chatId, messageId);
  if (parts[0] === "cfworkers") return showWorkers(env, chatId, clampPage(parts[1]), messageId);
  if (data === "cf:storage") return showStorageCategories(env, chatId, messageId);
  if (parts[0] === "store") return showStorageList(env, chatId, parts[1], clampPage(parts[2]), messageId);
  if (data === "cf:analytics") return showAnalytics(env, chatId, messageId);
  if (data === "cf:logs") return showLogsAndReports(env, chatId, messageId);
  if (data === "cf:pages") return showCloudflarePages(env, chatId, 0, messageId);
  if (parts[0] === "cfpages") return showCloudflarePages(env, chatId, clampPage(parts[1]), messageId);
  if (data === "cf:links") return showCloudflareLinks(env, chatId, messageId);
  if (parts[0] === "repo") {
    const target = await dereference(env, parts[1], "repo", cq.from.id);
    if (!target) return edit("⌛ این دکمه منقضی شده است؛ منوی مخزن‌ها را دوباره باز کن.", homeKeyboard());
    return showRepoByName(env, chatId, target, messageId);
  }
  if (parts[0] === "ghpage") {
    const target = await dereference(env, parts[1], "ghpage", cq.from.id);
    if (!target) return edit("⌛ این دکمه منقضی شده است؛ فهرست Pages را دوباره باز کن.", homeKeyboard());
    return showGitHubPageDetail(env, chatId, target, messageId);
  }
  if (parts[0] === "worker") {
    const target = await dereference(env, parts[1], "worker", cq.from.id);
    if (!target) return edit("⌛ این دکمه منقضی شده است؛ فهرست Workerها را دوباره باز کن.", homeKeyboard());
    return showWorkerByName(env, chatId, target, messageId);
  }
  if (parts[0] === "metric") {
    const target = await dereference(env, parts[1], "worker", cq.from.id);
    if (!target) return edit("⌛ این دکمه منقضی شده است؛ فهرست Workerها را دوباره باز کن.", homeKeyboard());
    return showWorkerMetrics(env, chatId, target, parts[2] === "7d" ? 168 : 24, messageId);
  }
  if (parts[0] === "item") {
    const kind = parts[1];
    const target = await dereference(env, parts[2], kind, cq.from.id);
    if (!target) return edit("⌛ این دکمه منقضی شده است؛ فهرست منابع را دوباره باز کن.", homeKeyboard());
    return showStorageItem(env, chatId, kind, target, messageId);
  }
  return edit(homeText(env), homeKeyboard());
}

function homeText(env) {
  return `🛰️ <b>DevPulse | Infra Radar</b>\n<blockquote>داشبورد شخصی و فقط‌خواندنی برای GitHub و Cloudflare</blockquote>\n\n<b>دسترسی‌ها</b>\n🐙 GitHub: <code>${html(env.GITHUB_USERNAME || "تنظیم نشده")}</code>\n☁️ Cloudflare Account: <code>${html(env.CLOUDFLARE_ACCOUNT_ID || "تنظیم نشده")}</code>\n🛡️ حالت دسترسی: <b>READ ONLY</b>\n\nاز دکمه‌ها برای مشاهده آمار زنده، فهرست منابع و لینک‌های مستقیم داشبورد استفاده کن. اعداد از API خوانده می‌شوند؛ اگر مجوزی نباشد، ربات همان محدودیت را نشان می‌دهد.`;
}

function homeKeyboard() {
  return kb([
    [cb("🐙 GitHub overview", "gh"), cb("☁️ Cloudflare overview", "cf")],
    [cb("📦 Repositories", "gh:repos"), cb("🌐 GitHub Pages", "gh:pages")],
    [cb("⚙️ Workers", "cf:workers"), cb("🗄️ Storage", "cf:storage")],
    [cb("📊 Analytics", "cf:analytics"), cb("📜 Logs & reports", "cf:logs")],
    [cb("🔗 Quick links", "cf:links"), cb("🔄 Refresh", "home")],
  ]);
}

async function showHome(env, chatId) {
  await tgSend(env, chatId, homeText(env), homeKeyboard());
}

async function sendHelp(env, chatId) {
  const text = `🧭 <b>راهنمای DevPulse</b>\n\n<code>/start</code> — منوی اصلی\n<code>/github</code> — نمای GitHub\n<code>/cloudflare</code> — نمای Cloudflare\n<code>/repo owner/name</code> — جزئیات یک ریپو\n<code>/worker script-name</code> — جزئیات یک Worker\n<code>/help</code> — راهنما\n\n<blockquote>امنیت: فقط شناسه‌ی تلگرام تنظیم‌شده مجاز است. این ربات عملیات تغییر، انتشار، حذف، نوشتن روی منابع GitHub/Cloudflare، خواندن مقدار Secretها یا محتوای فایل‌های ذخیره‌سازی انجام نمی‌دهد.</blockquote>\n\nداده‌ی ترافیک GitHub معمولاً به ۱۴ روز اخیر محدود است. آمار Pages جدا از آمار ترافیک ریپو در دسترس نیست مگر خودت analytics جداگانه وصل کرده باشی. برای لاگ‌های Cloudflare لینک مستقیم Observability ارائه می‌شود تا نیازی به مجوز نوشتنی Observability نباشد.`;
  await tgSend(env, chatId, text, homeKeyboard());
}

async function showGitHub(env, chatId, messageId) {
  const text = await withBusy(async () => {
    const [profile, repos] = await Promise.all([
      ghApi(env, `/users/${encodeURIComponent(env.GITHUB_USERNAME)}`),
      ghRepos(env).catch(() => null),
    ]);
    const repoCount = repos ? repos.length : "—";
    return `🐙 <b>GitHub overview</b>\n<blockquote>${html(profile.name || profile.login)} (@${html(profile.login)})</blockquote>\n\n📦 ریپوهای قابل‌دسترسی مالک: <b>${fmt(repoCount)}</b>\n🌍 Public repositories: <b>${fmt(profile.public_repos)}</b>\n👥 Followers: <b>${fmt(profile.followers)}</b>\n➡️ Following: <b>${fmt(profile.following)}</b>\n📅 عضویت از: <code>${fmtDate(profile.created_at)}</code>\n\n🔗 <a href="${attr(profile.html_url)}">پروفایل GitHub</a>\n<blockquote>داده‌های خصوصی فقط در صورت انتخاب ریپوهای مجاز و تنظیم درست Fine-grained token نمایش داده می‌شوند.</blockquote>`;
  });
  const keyboard = kb([
    [cb("📦 Repositories", "gh:repos"), cb("🌐 GitHub Pages", "gh:pages")],
    [cb("🕓 Public activity", "gh:events"), cb("🔗 GitHub links", "gh:links")],
    [urlBtn("👤 Profile", `https://github.com/${encodeURIComponent(env.GITHUB_USERNAME)}`)],
    [cb("⬅️ Main menu", "home")],
  ]);
  return sendOrEdit(env, chatId, messageId, text, keyboard);
}

async function showGitHubLinks(env, chatId, messageId) {
  const user = encodeURIComponent(env.GITHUB_USERNAME);
  const text = `🔗 <b>GitHub quick links</b>\n\nلینک‌های مستقیم برای ریپوها، Pages، Actions، Issueها و امنیت حساب. این لینک‌ها اطلاعات بیشتری را در رابط رسمی GitHub نشان می‌دهند و ربات هیچ تغییری در آن‌ها ایجاد نمی‌کند.`;
  return sendOrEdit(env, chatId, messageId, text, kb([
    [urlBtn("👤 Profile", `https://github.com/${user}`), urlBtn("📦 Repositories", `https://github.com/${user}?tab=repositories`)],
    [urlBtn("🌐 Pages settings", `https://github.com/${user}?tab=repositories`), urlBtn("🕓 Activity", `https://github.com/${user}?tab=activity`)],
    [urlBtn("⚙️ Actions", `https://github.com/${user}?tab=packages`), urlBtn("🔐 Security", `https://github.com/${user}?tab=security`)],
    [cb("⬅️ GitHub overview", "gh"), cb("🏠 Main menu", "home")],
  ]));
}

async function showRepos(env, chatId, page = 0, messageId) {
  try {
    const repos = await ghRepos(env);
    const pageSize = 8;
    const start = page * pageSize;
    const selected = repos.slice(start, start + pageSize);
    const rows = [];
    for (const repo of selected) {
      const ref = await rememberRef(env, env.TELEGRAM_OWNER_ID, "repo", repo.full_name);
      const meta = `${repo.private ? "🔒" : "🌍"} ${repo.stargazers_count ?? 0}★ · ${repo.forks_count ?? 0}⑂`;
      rows.push([cb(`📁 ${truncate(repo.name, 28)} · ${meta}`, `repo:${ref}`), urlBtn("↗️", repo.html_url)]);
    }
    const nav = [];
    if (page > 0) nav.push(cb("⬅️ قبلی", `ghrepos:${page - 1}`));
    if (start + pageSize < repos.length) nav.push(cb("بعدی ➡️", `ghrepos:${page + 1}`));
    if (nav.length) rows.push(nav);
    rows.push([cb("🌐 GitHub Pages", "gh:pages"), cb("🐙 Overview", "gh")]);
    rows.push([cb("🏠 Main menu", "home")]);
    const text = `📦 <b>GitHub repositories</b>\n<blockquote>مرتب‌شده بر اساس آخرین به‌روزرسانی — داده‌ی زنده از API</blockquote>\n\nمجموع ریپوهای مالک قابل‌دسترسی: <b>${repos.length}</b>\nصفحه: <b>${page + 1}</b> از <b>${Math.max(1, Math.ceil(repos.length / pageSize))}</b>\n\n${selected.length ? selected.map((r, i) => `${start + i + 1}. <b>${html(r.name)}</b> ${r.private ? "🔒 Private" : "🌍 Public"}\n   <code>${html(r.full_name)}</code>\n   ⭐ ${fmt(r.stargazers_count)} · 🍴 ${fmt(r.forks_count)} · ${html(r.language || "Language N/A")}`).join("\n\n") : "ریپویی برای نمایش پیدا نشد."}`;
    return sendOrEdit(env, chatId, messageId, text, kb(rows));
  } catch (err) {
    return sendOrEdit(env, chatId, messageId, apiErrorText("GitHub repository list", err), homeKeyboard());
  }
}

async function ghRepos(env) {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const items = await ghApi(env, `/user/repos?visibility=all&affiliation=owner&sort=updated&per_page=100&page=${page}`);
    if (!Array.isArray(items)) throw new Error("GitHub API did not return repository list");
    all.push(...items);
    if (items.length < 100) break;
  }
  return all.filter((r) => r.owner?.login?.toLowerCase() === String(env.GITHUB_USERNAME).toLowerCase());
}

async function showRepoByName(env, chatId, fullName, messageId) {
  const clean = String(fullName || "").trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/\/$/, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(clean)) {
    const msg = `نام ریپو معتبر نیست. قالب درست: <code>owner/repository</code>\nمثال: <code>${html(env.GITHUB_USERNAME)}/devpulse-infra-bot</code>`;
    return sendOrEdit(env, chatId, messageId, msg, homeKeyboard());
  }
  try {
    const repo = await ghApi(env, `/repos/${clean}`);
    const [views, clones, runs, pageCfg] = await Promise.all([
      ghApi(env, `/repos/${clean}/traffic/views`).catch((e) => ({ __error: shortError(e) })),
      ghApi(env, `/repos/${clean}/traffic/clones`).catch((e) => ({ __error: shortError(e) })),
      ghApi(env, `/repos/${clean}/actions/runs?per_page=5`).catch((e) => ({ __error: shortError(e) })),
      repo.has_pages ? ghApi(env, `/repos/${clean}/pages`).catch((e) => ({ __error: shortError(e) })) : Promise.resolve(null),
    ]);
    const description = repo.description ? html(repo.description) : "بدون توضیحات";
    const trafficViewText = views?.__error ? `در دسترس نیست (${html(views.__error)})` : `${fmt(views.count)} بازدید / ${fmt(views.uniques)} بازدیدکننده یکتا`;
    const trafficCloneText = clones?.__error ? `در دسترس نیست (${html(clones.__error)})` : `${fmt(clones.count)} کلون / ${fmt(clones.uniques)} کلون‌کننده یکتا`;
    const runRows = Array.isArray(runs?.workflow_runs) ? runs.workflow_runs.slice(0, 5) : [];
    const runText = runs?.__error ? `در دسترس نیست (${html(runs.__error)})` : runRows.length ? runRows.map((r) => `• ${statusEmoji(r.conclusion, r.status)} <a href="${attr(r.html_url)}">${html(truncate(r.name || `Run ${r.id}`, 40))}</a> — <code>${html(r.status)}${r.conclusion ? `/${html(r.conclusion)}` : ""}</code>`).join("\n") : "اجرای اخیر پیدا نشد.";
    const pagesText = !repo.has_pages ? "برای این ریپو Pages فعال نیست (طبق متادیتای API)." : pageCfg?.__error ? `Pages فعال/قابل‌خواندن است، اما جزئیات API در دسترس نیست: ${html(pageCfg.__error)}` : `<a href="${attr(pageCfg.html_url)}">${html(pageCfg.html_url)}</a> · Status: <code>${html(pageCfg.status || "unknown")}</code>`;
    const size = `${fmt(repo.size)} KB repository size`;
    const text = `📁 <b>${html(repo.full_name)}</b> ${repo.private ? "🔒" : "🌍"}\n<blockquote>${description}</blockquote>\n\n<b>Repository metadata</b>\n⭐ Stars: <b>${fmt(repo.stargazers_count)}</b> · 🍴 Forks: <b>${fmt(repo.forks_count)}</b> · 👁 Watchers: <b>${fmt(repo.subscribers_count)}</b>\n🐛 Open issues: <b>${fmt(repo.open_issues_count)}</b> · 🌿 Default branch: <code>${html(repo.default_branch || "—")}</code>\n💻 Language: <b>${html(repo.language || "N/A")}</b> · ${size}\n📅 Created: <code>${fmtDate(repo.created_at)}</code>\n🔄 Updated: <code>${fmtDate(repo.updated_at)}</code>\n📄 License: <code>${html(repo.license?.spdx_id || "—")}</code>\n🧊 Archived: <b>${repo.archived ? "Yes" : "No"}</b>\n\n<b>Traffic · GitHub’s available recent window</b>\n👀 Views: ${trafficViewText}\n📥 Clones: ${trafficCloneText}\n\n<b>GitHub Pages</b>\n${pagesText}\n\n<b>Recent GitHub Actions runs</b>\n${runText}\n\n<blockquote>ترافیک GitHub معمولاً فقط ۱۴ روز اخیر است. اگر endpoint ترافیک 403 بدهد، توکن باید Administration: Read داشته باشد و حساب نیز دسترسی لازم روی ریپو داشته باشد. اطلاعات API ممکن است بسته به مجوزها کامل نباشد.</blockquote>`;
    return sendOrEdit(env, chatId, messageId, text, kb([
      [urlBtn("🔗 Repository", repo.html_url), urlBtn("📊 Traffic", `${repo.html_url}/graphs/traffic`)],
      [urlBtn("⚙️ Actions", `${repo.html_url}/actions`), urlBtn("🌿 Branches", `${repo.html_url}/branches/all`)],
      [urlBtn("🐛 Issues", `${repo.html_url}/issues`), urlBtn("🔀 Pull requests", `${repo.html_url}/pulls`)],
      [urlBtn("📦 Releases", `${repo.html_url}/releases`), urlBtn("📜 Commits", `${repo.html_url}/commits/${encodeURIComponent(repo.default_branch || "main")}`)],
      [cb("📦 All repositories", "gh:repos"), cb("🏠 Main menu", "home")],
    ]));
  } catch (err) {
    return sendOrEdit(env, chatId, messageId, apiErrorText(`Repository ${clean}`, err), homeKeyboard());
  }
}

async function showPages(env, chatId, page = 0, messageId) {
  try {
    const repos = await ghRepos(env);
    const candidates = repos.filter((r) => r.has_pages);
    const pageSize = 8;
    const start = page * pageSize;
    const selected = candidates.slice(start, start + pageSize);
    const configs = await mapLimit(selected, 5, async (r) => ({ repo: r, cfg: await ghApi(env, `/repos/${r.full_name}/pages`).catch((e) => ({ __error: shortError(e) })) }));
    const rows = [];
    for (const { repo, cfg } of configs) {
      const target = await rememberRef(env, env.TELEGRAM_OWNER_ID, "ghpage", repo.full_name);
      rows.push([cb(`🌐 ${truncate(repo.name, 28)}${cfg?.status ? ` · ${cfg.status}` : ""}`, `ghpage:${target}`), urlBtn("↗️ Repo", repo.html_url)]);
    }
    const nav = [];
    if (page > 0) nav.push(cb("⬅️ قبلی", `ghpages:${page - 1}`));
    if (start + pageSize < candidates.length) nav.push(cb("بعدی ➡️", `ghpages:${page + 1}`));
    if (nav.length) rows.push(nav);
    rows.push([cb("📦 Repositories", "gh:repos"), cb("🐙 Overview", "gh")]);
    rows.push([cb("🏠 Main menu", "home")]);
    const body = configs.length ? configs.map(({ repo, cfg }) => {
      const url = cfg?.html_url || repo.homepage || inferredGithubPagesUrl(repo);
      const status = cfg?.__error ? `API detail unavailable (${html(cfg.__error)})` : html(cfg?.status || "enabled flag; status unavailable");
      return `• <b>${html(repo.full_name)}</b>\n  🔗 <a href="${attr(url)}">${html(url)}</a>\n  State: <code>${status}</code> · Branch: <code>${html(cfg?.source?.branch || repo.default_branch || "—")}</code>`;
    }).join("\n\n") : "هیچ ریپویی با فلگ has_pages پیدا نشد یا دسترسی API محدود است.";
    const text = `🌐 <b>GitHub Pages</b>\n<blockquote>فهرست داینامیک ریپوهایی که در API علامت Pages دارند</blockquote>\n\nتعداد کاندیداها: <b>${candidates.length}</b> · صفحه ${page + 1}\n\n${body}\n\n<blockquote>این endpoint آمار بازدید سایت Pages ارائه نمی‌کند؛ لینک‌های سایت و وضعیت build در صورت دسترسی نمایش داده می‌شوند. آمار بازدید خود ریپو با بازدید سایت Pages یکی نیست.</blockquote>`;
    return sendOrEdit(env, chatId, messageId, text, kb(rows));
  } catch (err) {
    return sendOrEdit(env, chatId, messageId, apiErrorText("GitHub Pages", err), homeKeyboard());
  }
}

async function showGitHubPageDetail(env, chatId, fullName, messageId) {
  const repoUrl = `https://github.com/${fullName}`;
  try {
    const cfg = await ghApi(env, `/repos/${fullName}/pages`);
    const builds = await ghApi(env, `/repos/${fullName}/pages/builds?per_page=5`).catch((e) => ({ __error: shortError(e) }));
    const buildText = builds?.__error ? html(builds.__error) : Array.isArray(builds) && builds.length ? builds.map((b) => `• ${statusEmoji(b.status, b.status)} <code>${html(b.status || "unknown")}</code> — ${html(fmtDate(b.created_at))}`).join("\n") : "Build record پیدا نشد.";
    return sendOrEdit(env, chatId, messageId, `🌐 <b>GitHub Pages · ${html(fullName)}</b>\n\nURL: <a href="${attr(cfg.html_url || inferredGithubPagesUrl({ full_name: fullName, owner: { login: fullName.split("/")[0] }, name: fullName.split("/")[1] }))}">${html(cfg.html_url || "URL not returned")}</a>\nStatus: <code>${html(cfg.status || "unknown")}</code>\nBuild type: <code>${html(cfg.build_type || "unknown")}</code>\nSource branch: <code>${html(cfg.source?.branch || "—")}</code>\nSource path: <code>${html(cfg.source?.path || "—")}</code>\nCustom domain: <code>${html(cfg.cname || "—")}</code>\nPrivate publishing: <code>${String(cfg.public ?? "unknown")}</code>\n\n<b>Recent builds</b>\n${buildText}\n\n<blockquote>آمار بازدید Pages به‌صورت built-in از این API ارائه نمی‌شود.</blockquote>`, kb([
      [urlBtn("🌐 Open site", cfg.html_url || inferredGithubPagesUrl({ full_name: fullName, owner: { login: fullName.split("/")[0] }, name: fullName.split("/")[1] })), urlBtn("⚙️ Settings", `${repoUrl}/settings/pages`)],
      [urlBtn("🧱 Builds", `${repoUrl}/deployments`), urlBtn("📊 Repo traffic", `${repoUrl}/graphs/traffic`)],
      [cb("⬅️ Pages list", "gh:pages"), cb("🏠 Main menu", "home")],
    ]));
  } catch (err) {
    return sendOrEdit(env, chatId, messageId, apiErrorText(`GitHub Pages ${fullName}`, err), homeKeyboard());
  }
}

async function showGitHubEvents(env, chatId, messageId) {
  try {
    const events = await ghApi(env, `/users/${encodeURIComponent(env.GITHUB_USERNAME)}/events/public?per_page=10`);
    const textRows = (Array.isArray(events) ? events : []).slice(0, 10).map((e) => `• <b>${html(e.type || "Event")}</b> · <a href="https://github.com/${attr(e.repo?.name || env.GITHUB_USERNAME)}">${html(e.repo?.name || "profile")}</a>\n  <code>${fmtDate(e.created_at)}</code>`);
    return sendOrEdit(env, chatId, messageId, `🕓 <b>Recent public activity</b>\n<blockquote>فقط eventهای public که API برمی‌گرداند</blockquote>\n\n${textRows.length ? textRows.join("\n\n") : "فعالیت عمومی قابل‌نمایشی برنگشت."}`, kb([
      [urlBtn("📅 GitHub activity", `https://github.com/${encodeURIComponent(env.GITHUB_USERNAME)}?tab=activity`)],
      [cb("📦 Repositories", "gh:repos"), cb("⬅️ GitHub", "gh")],
    ]));
  } catch (err) {
    return sendOrEdit(env, chatId, messageId, apiErrorText("GitHub activity", err), homeKeyboard());
  }
}

async function showCloudflare(env, chatId, messageId) {
  const acct = env.CLOUDFLARE_ACCOUNT_ID || "";
  const results = await Promise.allSettled([
    cfApi(env, `/accounts/${encodeURIComponent(acct)}`),
    cfList(env, `/accounts/${encodeURIComponent(acct)}/workers/scripts`, ["scripts"]),
    cfList(env, `/accounts/${encodeURIComponent(acct)}/pages/projects`, ["projects"]),
  ]);
  const account = results[0].status === "fulfilled" ? results[0].value : null;
  const workers = results[1].status === "fulfilled" ? results[1].value : null;
  const pages = results[2].status === "fulfilled" ? results[2].value : null;
  const part = (r) => r.status === "fulfilled" ? "OK" : `Unavailable: ${shortError(r.reason)}`;
  const text = `☁️ <b>Cloudflare overview</b>\n<blockquote>داده‌ی زنده از Cloudflare API؛ فقط‌خواندنی</blockquote>\n\n🏢 Account: <b>${html(account?.name || "اطلاعات نامشخص")}</b>\n🆔 Account ID: <code>${html(acct || "NOT SET")}</code>\n⚙️ Workers: <b>${workers ? workers.length : "—"}</b> <code>${html(part(results[1]))}</code>\n🌐 Pages projects: <b>${pages ? pages.length : "—"}</b> <code>${html(part(results[2]))}</code>\n🔐 Account endpoint: <code>${html(part(results[0]))}</code>\n\n<b>Resource browser</b>\nهمه‌ی منابع فقط در حدی نمایش داده می‌شوند که توکن read-only اجازه بدهد. مقادیر Secrets، KV valueها و محتوای objectهای R2 عمداً استخراج نمی‌شوند.`;
  return sendOrEdit(env, chatId, messageId, text, kb([
    [cb("⚙️ Workers", "cf:workers"), cb("🌐 Worker domains", "cf:domains")],
    [cb("🌐 Pages projects", "cf:pages"), cb("🗄️ Storage inventory", "cf:storage")],
    [cb("📊 Worker analytics", "cf:analytics"), cb("📜 Logs & reports", "cf:logs")],
    [cb("🔗 Dashboard links", "cf:links")],
    [cb("🏠 Main menu", "home")],
  ]));
}

async function showWorkers(env, chatId, page = 0, messageId) {
  try {
    const workers = await cfList(env, `/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/workers/scripts`, ["scripts"]);
    const pageSize = 8;
    const start = page * pageSize;
    const selected = workers.slice(start, start + pageSize);
    const rows = [];
    for (const w of selected) {
      const name = w.id || w.script_name || w.name;
      if (!name) continue;
      const ref = await rememberRef(env, env.TELEGRAM_OWNER_ID, "worker", name);
      rows.push([cb(`⚙️ ${truncate(name, 32)}`, `worker:${ref}`), urlBtn("📊", cfWorkerMetricsUrl(env))]);
    }
    const nav = [];
    if (page > 0) nav.push(cb("⬅️ قبلی", `cfworkers:${page - 1}`));
    if (start + pageSize < workers.length) nav.push(cb("بعدی ➡️", `cfworkers:${page + 1}`));
    if (nav.length) rows.push(nav);
    rows.push([cb("🌐 Worker domains", "cf:domains"), cb("📊 Analytics", "cf:analytics")]);
    rows.push([cb("📜 Logs", "cf:logs"), cb("⬅️ Cloudflare", "cf")]);
    rows.push([cb("🏠 Main menu", "home")]);
    const list = selected.map((w) => `• <b>${html(w.id || w.script_name || w.name || "Worker")}</b>\n  Updated: <code>${fmtDate(w.modified_on || w.created_on)}</code> · Compatibility: <code>${html(w.compatibility_date || "—")}</code>\n  Handlers: <code>${html((w.handlers || []).join(", ") || "—")}</code>`).join("\n\n");
    return sendOrEdit(env, chatId, messageId, `⚙️ <b>Cloudflare Workers</b>\n<blockquote>فهرست اسکریپت‌های Worker در این Account</blockquote>\n\nمجموع: <b>${workers.length}</b> · صفحه ${page + 1}\n\n${list || "Workerی پیدا نشد یا مجوز API کافی نیست."}`, kb(rows));
  } catch (err) {
    return sendOrEdit(env, chatId, messageId, apiErrorText("Cloudflare Workers", err), homeKeyboard());
  }
}

async function showWorkerByName(env, chatId, name, messageId) {
  const scriptName = String(name || "").trim();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(scriptName)) return sendOrEdit(env, chatId, messageId, "نام Worker معتبر نیست.", homeKeyboard());
  try {
    const accountPath = `/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}`;
    const [scripts, settings, schedules, deployments] = await Promise.all([
      cfList(env, `${accountPath}/workers/scripts`, ["scripts"]),
      cfApi(env, `${accountPath}/workers/scripts/${encodeURIComponent(scriptName)}/script-settings`).catch((e) => ({ __error: shortError(e) })),
      cfApi(env, `${accountPath}/workers/scripts/${encodeURIComponent(scriptName)}/schedules`).catch((e) => ({ __error: shortError(e) })),
      cfList(env, `${accountPath}/workers/scripts/${encodeURIComponent(scriptName)}/deployments?per_page=5`, ["deployments"]).catch((e) => ({ __error: shortError(e) })),
    ]);
    const worker = scripts.find((w) => (w.id || w.script_name || w.name) === scriptName) || {};
    const bindings = Array.isArray(worker?.bindings) ? worker.bindings : Array.isArray(worker?.metadata?.bindings) ? worker.metadata.bindings : [];
    const scheduleRows = Array.isArray(schedules) ? schedules : Array.isArray(schedules?.schedules) ? schedules.schedules : [];
    const scheduleText = schedules?.__error ? `Unavailable (${html(schedules.__error)})` : scheduleRows.length ? scheduleRows.map((s) => `${html(s.cron || s.schedule || "cron")}`).join(", ") : "No schedules returned";
    const settingText = settings?.__error ? `Settings unavailable (${html(settings.__error)})` : `Observability: <code>${String(settings?.observability?.enabled ?? settings?.settings?.observability?.enabled ?? "unknown")}</code> · Logpush: <code>${String(settings?.logpush ?? settings?.settings?.logpush ?? "unknown")}</code>`;
    const deploymentRows = Array.isArray(deployments) ? deployments.slice(0, 3) : [];
    const deploymentText = deployments?.__error ? `Unavailable (${html(deployments.__error)})` : deploymentRows.length ? deploymentRows.map((d) => `• <code>${html(d.id || "deployment")}</code> · ${fmtDate(d.created_on)} · ${html(d.annotations?.["workers/message"] || d.source || "deployment")} · ${html((d.versions || []).map((v) => `${v.percentage}%`).join(" / ") || "version info N/A")}`).join("\n") : "No deployment records returned";
    const safeBindings = bindings.map((b) => `• <code>${html(b.type || "binding")}</code> — <b>${html(b.name || "unnamed")}</b>`).join("\n");
    const ref = await rememberRef(env, env.TELEGRAM_OWNER_ID, "worker", scriptName);
    return sendOrEdit(env, chatId, messageId, `⚙️ <b>Worker · ${html(scriptName)}</b>\n\n🧭 Compatibility: <code>${html(worker.compatibility_date || "N/A")}</code> · Modified: <code>${fmtDate(worker.modified_on)}</code>\n${settingText}\n⏱️ Schedules: ${scheduleText}\n📦 Binding metadata: <b>${bindings.length}</b>\n${safeBindings || "این endpoint نام bindingها را برنگرداند؛ مقدارها در هیچ حالتی خوانده نمی‌شوند."}\n\n<b>Latest deployments</b>\n${deploymentText}\n\n🔗 Metrics: <a href="${attr(cfWorkerMetricsUrl(env))}">Cloudflare Workers metrics</a>\n📜 Logs: <a href="${attr(cfObservabilityUrl(env))}">Workers Observability</a>\n\n<blockquote>مقادیر Secret و Environment variables نمایش داده نمی‌شوند. ممکن است تنظیمات جزئی بسته به نوع Worker و permission API در دسترس نباشد.</blockquote>`, kb([
      [cb("📊 Metrics · 24h", `metric:${ref}:24h`), cb("📊 Metrics · 7d", `metric:${ref}:7d`)],
      [urlBtn("⚙️ Worker dashboard", cfWorkerDetailUrl(env, scriptName)), urlBtn("📜 Logs", cfObservabilityUrl(env))],
      [urlBtn("🧬 Versions / deployments", `${cfWorkerDetailUrl(env, scriptName)}/deployments`)],
      [cb("⚙️ All Workers", "cf:workers"), cb("🌐 Domains", "cf:domains")],
      [cb("🏠 Main menu", "home")],
    ]));
  } catch (err) {
    return sendOrEdit(env, chatId, messageId, apiErrorText(`Worker ${scriptName}`, err), kb([[urlBtn("📊 Workers dashboard", cfWorkersUrl(env))], [cb("⬅️ All Workers", "cf:workers"), cb("🏠 Main menu", "home")]]));
  }
}

async function showWorkerMetrics(env, chatId, scriptName, hours, messageId) {
  try {
    const metrics = await cfWorkersMetrics(env, scriptName, hours);
    const range = hours > 24 ? "7 روز گذشته" : "24 ساعت گذشته";
    const text = `📊 <b>Worker analytics · ${html(scriptName)}</b>\n<blockquote>${range} · Cloudflare GraphQL Analytics</blockquote>\n\n📨 Requests: <b>${fmt(metrics.requests)}</b>\n❌ Errors: <b>${fmt(metrics.errors)}</b>\n🔁 Subrequests: <b>${fmt(metrics.subrequests)}</b>\n⚡ CPU p50: <code>${fmt(metrics.cpuP50)} ms</code>\n⚡ CPU p99: <code>${fmt(metrics.cpuP99)} ms</code>\n\n<a href="${attr(cfWorkerMetricsUrl(env))}">Open Cloudflare Metrics dashboard</a>\n\n<blockquote>اگر API عددی برنگرداند یا مجوز Analytics محدود باشد، عدد صفر فرض نمی‌شود؛ خطا نمایش داده می‌شود.</blockquote>`;
    const ref = await rememberRef(env, env.TELEGRAM_OWNER_ID, "worker", scriptName);
    return sendOrEdit(env, chatId, messageId, text, kb([
      [cb("↻ 24h", `metric:${ref}:24h`), cb("↻ 7d", `metric:${ref}:7d`)],
      [urlBtn("📊 Dashboard", cfWorkerDetailUrl(env, scriptName)), urlBtn("📜 Logs", cfObservabilityUrl(env))],
      [cb("⬅️ Worker detail", `worker:${ref}`), cb("🏠 Main menu", "home")],
    ]));
  } catch (err) {
    return sendOrEdit(env, chatId, messageId, apiErrorText("Cloudflare GraphQL Worker analytics", err) + `\n\n<a href="${attr(cfWorkerMetricsUrl(env))}">Open Cloudflare analytics</a>`, kb([
      [urlBtn("📊 Analytics dashboard", cfWorkerMetricsUrl(env)), urlBtn("📜 Observability", cfObservabilityUrl(env))],
      [cb("⬅️ Workers", "cf:workers"), cb("🏠 Main menu", "home")],
    ]));
  }
}

async function cfWorkersMetrics(env, scriptName, hours) {
  const accountTag = env.CLOUDFLARE_ACCOUNT_ID;
  const to = new Date();
  const from = new Date(to.getTime() - hours * 3600_000);
  const hasScript = Boolean(scriptName);
  const filter = hasScript
    ? `scriptName: $scriptName, datetime_geq: $datetimeStart, datetime_leq: $datetimeEnd`
    : `datetime_geq: $datetimeStart, datetime_leq: $datetimeEnd`;
  const variablesDecl = hasScript
    ? `($accountTag: string, $datetimeStart: string, $datetimeEnd: string, $scriptName: string)`
    : `($accountTag: string, $datetimeStart: string, $datetimeEnd: string)`;
  const query = `query DevPulseWorkersMetrics${variablesDecl} { viewer { accounts(filter: {accountTag: $accountTag}) { workersInvocationsAdaptive(limit: 100, filter: { ${filter} }) { sum { subrequests requests errors } quantiles { cpuTimeP50 cpuTimeP99 } } } } }`;
  const variables = { accountTag, datetimeStart: from.toISOString(), datetimeEnd: to.toISOString() };
  if (hasScript) variables.scriptName = scriptName;
  const response = await fetch(`${CF_API}/graphql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.errors?.length) throw new Error(json.errors?.map((e) => e.message).join("; ") || `Cloudflare GraphQL HTTP ${response.status}`);
  const rows = json.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("GraphQL returned no Worker metric rows for this period; check Analytics Read permissions, account ID, and traffic in the selected range.");
  const sum = (key) => {
    const values = rows.map((row) => row.sum?.[key]).filter((value) => value !== null && value !== undefined && Number.isFinite(Number(value)));
    return values.length ? values.reduce((acc, value) => acc + Number(value), 0) : "N/A";
  };
  const quantile = (key) => {
    const values = rows.map((row) => row.quantiles?.[key]).filter((value) => value !== null && value !== undefined && Number.isFinite(Number(value)));
    return values.length ? Math.round(values.reduce((acc, value) => acc + Number(value), 0) / values.length) : "N/A";
  };
  return {
    requests: sum("requests"), errors: sum("errors"), subrequests: sum("subrequests"),
    cpuP50: quantile("cpuTimeP50"),
    cpuP99: quantile("cpuTimeP99"),
  };
}

async function showAnalytics(env, chatId, messageId) {
  let metricsLine = "آمار تجمیعی از Workerها هنوز بارگذاری نشده؛ برای جزئیات یک Worker را انتخاب کن.";
  try {
    const metrics = await cfWorkersMetrics(env, null, 24);
    metricsLine = `📨 Requests (24h): <b>${fmt(metrics.requests)}</b>\n❌ Errors: <b>${fmt(metrics.errors)}</b>\n🔁 Subrequests: <b>${fmt(metrics.subrequests)}</b>\n⚡ CPU p50 / p99: <code>${fmt(metrics.cpuP50)} / ${fmt(metrics.cpuP99)} ms</code>`;
  } catch (err) {
    metricsLine = `آمار API در دسترس نیست: <code>${html(shortError(err))}</code>`;
  }
  return sendOrEdit(env, chatId, messageId, `📊 <b>Cloudflare analytics</b>\n<blockquote>آمار اجرای Workers با GraphQL Analytics API</blockquote>\n\n${metricsLine}\n\n<b>داشبوردهای رسمی</b>\nبرای گزارش‌های گسترده‌تر، نمودارهای zone، usage/billing و لاگ‌های کامل از لینک‌های رسمی استفاده کن. ربات اطلاعاتی را که API یا مجوزهای حساب ارائه نکنند جعل نمی‌کند.`, kb([
    [urlBtn("⚙️ Workers metrics", cfWorkerMetricsUrl(env)), urlBtn("📈 Account analytics", cfAnalyticsUrl(env))],
    [urlBtn("📜 Observability logs", cfObservabilityUrl(env)), urlBtn("💳 Billing / usage", cfBillingUrl(env))],
    [cb("⚙️ Workers list", "cf:workers"), cb("⬅️ Cloudflare", "cf")],
  ]));
}

async function showLogsAndReports(env, chatId, messageId) {
  const text = `📜 <b>Logs & reports</b>\n<blockquote>لینک‌های رسمی؛ فقط‌خواندنی</blockquote>\n\n🧾 <b>Cloudflare Workers Logs</b>\nلاگ‌های invocation، console، error و exception را در داشبورد بررسی کن. دریافت مستقیم query نتیجه‌ی Observability در API به permission خاصی با عنوان <code>Workers Observability Write</code> نیاز دارد؛ چون هدف این پروژه read-only است، آن permission را درخواست نمی‌کنیم.\n\n📊 <b>Usage / billing</b>\nمصرف حساب و هزینه‌ها را در داشبورد رسمی ببین؛ مقدارها بسته به پلن و فعال بودن سرویس متفاوت‌اند.\n\n🐙 <b>GitHub</b>\nبرای Actions، runها و build logs، از لینک‌های رسمی Actions استفاده کن. بخش جزئیات هر ریپو هم ۵ اجرای اخیر را در صورت دسترسی API نشان می‌دهد.`;
  return sendOrEdit(env, chatId, messageId, text, kb([
    [urlBtn("📜 Workers Observability", cfObservabilityUrl(env)), urlBtn("⚙️ Worker overview", cfWorkersUrl(env))],
    [urlBtn("📈 Cloudflare Analytics", cfAnalyticsUrl(env)), urlBtn("💳 Billing / usage", cfBillingUrl(env))],
    [urlBtn("🐙 GitHub Actions", `https://github.com/${encodeURIComponent(env.GITHUB_USERNAME)}?tab=repositories`)],
    [cb("📊 Analytics", "cf:analytics"), cb("⬅️ Cloudflare", "cf")],
  ]));
}

async function showWorkerDomains(env, chatId, messageId) {
  try {
    const domains = await cfList(env, `/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/workers/domains?per_page=100`, ["domains"]);
    const rows = domains.slice(0, 8).map((d) => {
      const host = d.hostname || d.name;
      const url = host ? `https://${host}` : cfWorkersUrl(env);
      return `• <b>${html(host || "Worker domain")}</b>\n  Service: <code>${html(d.service || d.script_name || d.script || "—")}</code> · Environment: <code>${html(d.environment || "—")}</code>\n  Zone: <code>${html(d.zone_name || d.zone_id || "—")}</code> · Enabled: <code>${String(d.enabled ?? "unknown")}</code>\n  ${host ? `<a href="${attr(url)}">Open hostname</a>` : ""}`;
    });
    const keyboardRows = domains.slice(0, 8).filter((d) => d.hostname || d.name).map((d) => [urlBtn(`↗️ ${truncate(d.hostname || d.name, 35)}`, `https://${d.hostname || d.name}`)]);
    keyboardRows.push([urlBtn("⚙️ Workers dashboard", cfWorkersUrl(env)), urlBtn("📜 Observability", cfObservabilityUrl(env))]);
    keyboardRows.push([cb("⚙️ Workers list", "cf:workers"), cb("⬅️ Cloudflare", "cf")]);
    keyboardRows.push([cb("🏠 Main menu", "home")]);
    const text = `🌐 <b>Cloudflare Worker domains</b>\nمجموع دامنه‌های متصل که API برگردانده: <b>${domains.length}</b>\n\n${rows.join("\n\n") || "دامنه‌ای برنگشت یا این حساب دامنه‌ی متصل ندارد."}\n\n<blockquote>این فهرست دامنه‌های API است؛ URL پیش‌فرض workers.dev ممکن است از این endpoint برنگردد. برای دیدن هر hostname فعال و مسیر دقیق از داشبورد Worker استفاده کن.</blockquote>`;
    return sendOrEdit(env, chatId, messageId, text, kb(keyboardRows));
  } catch (err) {
    return sendOrEdit(env, chatId, messageId, apiErrorText("Cloudflare Worker domains", err), kb([[urlBtn("⚙️ Workers dashboard", cfWorkersUrl(env))], [cb("⬅️ Cloudflare", "cf"), cb("🏠 Main menu", "home")]]));
  }
}

async function showCloudflarePages(env, chatId, page = 0, messageId) {
  try {
    const projects = await cfList(env, `/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/pages/projects?per_page=100`, ["projects"]);
    const pageSize = 8;
    const start = page * pageSize;
    const selected = projects.slice(start, start + pageSize);
    const rows = [];
    for (const p of selected) {
      const name = p.name || p.project_name;
      const url = p.domains?.[0] ? `https://${p.domains[0]}` : p.subdomain ? `https://${p.subdomain}` : "https://dash.cloudflare.com";
      const ref = await rememberRef(env, env.TELEGRAM_OWNER_ID, "pages", String(name));
      rows.push([cb(`🌐 ${truncate(name, 28)}`, `item:pages:${ref}`), urlBtn("↗️ Site", url)]);
    }
    const nav = [];
    if (page > 0) nav.push(cb("⬅️ قبلی", `cfpages:${page - 1}`));
    if (start + pageSize < projects.length) nav.push(cb("بعدی ➡️", `cfpages:${page + 1}`));
    if (nav.length) rows.push(nav);
    rows.push([urlBtn("📂 Pages dashboard", cfPagesUrl(env)), cb("⬅️ Cloudflare", "cf")]);
    rows.push([cb("🏠 Main menu", "home")]);
    const body = selected.map((p) => `• <b>${html(p.name || p.project_name || "Pages project")}</b>\n  Branch: <code>${html(p.production_branch || "—")}</code> · Created: <code>${fmtDate(p.created_on)}</code>\n  Domains: ${html((p.domains || []).join(", ") || p.subdomain || "—")}\n  Build command: <code>${html(p.build_config?.build_command || "—")}</code>`).join("\n\n");
    return sendOrEdit(env, chatId, messageId, `🌐 <b>Cloudflare Pages projects</b>\nمجموع: <b>${projects.length}</b> · صفحه ${page + 1}\n\n${body || "پروژه‌ای پیدا نشد یا دسترسی API کافی نیست."}\n\n<blockquote>فقط metadata پروژه نمایش داده می‌شود؛ deployment history و build logs از داشبورد هر پروژه قابل‌مشاهده‌اند.</blockquote>`, kb(rows));
  } catch (err) {
    return sendOrEdit(env, chatId, messageId, apiErrorText("Cloudflare Pages", err), homeKeyboard());
  }
}

async function showStorageCategories(env, chatId, messageId) {
  const text = `🗄️ <b>Cloudflare storage inventory</b>\n<blockquote>کاتالوگ منابع ذخیره‌سازی؛ بدون خواندن value یا محتوای فایل‌ها</blockquote>\n\nانتخاب کن تا فهرست داینامیک سرویس را ببینی. جزئیات واقعی (اندازه/نسخه/تعداد آیتم‌ها) فقط وقتی نشان داده می‌شود که endpoint و پلن Cloudflare آن را برگردانند.`;
  return sendOrEdit(env, chatId, messageId, text, kb([
    [cb("🧬 D1 databases", "store:d1:0"), cb("🪣 R2 buckets", "store:r2:0")],
    [cb("🗝️ KV namespaces", "store:kv:0"), cb("🧱 Durable Objects", "store:do:0")],
    [cb("📨 Queues", "store:queues:0"), cb("🔌 Hyperdrive", "store:hyperdrive:0")],
    [cb("🧠 Vectorize indexes", "store:vectorize:0"), cb("🌐 Pages projects", "cf:pages")],
    [cb("⬅️ Cloudflare", "cf"), cb("🏠 Main menu", "home")],
  ]));
}

const STORAGE_TYPES = {
  d1: { label: "D1 databases", path: "/d1/database?per_page=100", keys: ["databases"], icon: "🧬", dashboard: "d1" },
  r2: { label: "R2 buckets", path: "/r2/buckets?per_page=100", keys: ["buckets"], icon: "🪣", dashboard: "r2" },
  kv: { label: "KV namespaces", path: "/storage/kv/namespaces?per_page=100", keys: ["namespaces"], icon: "🗝️", dashboard: "kv" },
  do: { label: "Durable Objects namespaces", path: "/workers/durable_objects/namespaces?per_page=100", keys: ["namespaces"], icon: "🧱", dashboard: "workers" },
  queues: { label: "Queues", path: "/queues?per_page=100", keys: ["queues"], icon: "📨", dashboard: "queues" },
  hyperdrive: { label: "Hyperdrive configs", path: "/hyperdrive/configs?per_page=100", keys: ["result", "configs"], icon: "🔌", dashboard: "hyperdrive" },
  vectorize: { label: "Vectorize indexes", path: "/vectorize/v2/indexes", keys: ["indexes"], icon: "🧠", dashboard: "vectorize" },
};

async function showStorageList(env, chatId, type, page = 0, messageId) {
  const meta = STORAGE_TYPES[type];
  if (!meta) return sendOrEdit(env, chatId, messageId, "نوع storage ناشناخته است.", homeKeyboard());
  try {
    const list = await cfList(env, `/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}${meta.path}`, meta.keys);
    const pageSize = 8;
    const start = page * pageSize;
    const selected = list.slice(start, start + pageSize);
    const rows = [];
    for (const item of selected) {
      const name = storageName(type, item);
      const target = type === "d1" ? (item.uuid || item.id || name) : type === "r2" ? name : type === "kv" ? (item.id || name) : type === "do" ? (item.id || name) : type === "hyperdrive" ? (item.id || name) : name;
      const ref = await rememberRef(env, env.TELEGRAM_OWNER_ID, type, String(target));
      rows.push([cb(`${meta.icon} ${truncate(name, 28)}`, `item:${type}:${ref}`), urlBtn("↗️", storageDashboardUrl(env, type))]);
    }
    const nav = [];
    if (page > 0) nav.push(cb("⬅️ قبلی", `store:${type}:${page - 1}`));
    if (start + pageSize < list.length) nav.push(cb("بعدی ➡️", `store:${type}:${page + 1}`));
    if (nav.length) rows.push(nav);
    rows.push([cb("🗄️ Categories", "cf:storage"), cb("⬅️ Cloudflare", "cf")]);
    rows.push([cb("🏠 Main menu", "home")]);
    const details = selected.map((item) => {
      const name = storageName(type, item);
      if (type === "d1") return `• <b>${html(name)}</b> · <code>${html(item.uuid || item.id || "—")}</code>\n  Created: <code>${fmtDate(item.created_at || item.created_on)}</code> · Version: <code>${html(item.version || "—")}</code> · Tables: <code>${fmt(item.num_tables ?? "—")}</code>`;
      if (type === "r2") return `• <b>${html(name)}</b> · Class: <code>${html(item.storage_class || "—")}</code>\n  Location: <code>${html(item.location || item.jurisdiction || "—")}</code> · Created: <code>${fmtDate(item.creation_date)}</code>`;
      if (type === "kv") return `• <b>${html(name)}</b> · ID: <code>${html(item.id || "—")}</code>\n  Created: <code>${fmtDate(item.created_on)}</code> · Modified: <code>${fmtDate(item.modified_on)}</code>`;
      if (type === "do") return `• <b>${html(name)}</b> · Class: <code>${html(item.class || item.class_name || "—")}</code>\n  ID: <code>${html(item.id || "—")}</code>`;
      if (type === "queues") return `• <b>${html(name)}</b>\n  Created: <code>${fmtDate(item.created_on || item.created_at)}</code> · Consumers: <code>${fmt(item.consumers?.length ?? "—")}</code>`;
      if (type === "hyperdrive") return `• <b>${html(name)}</b> · ID: <code>${html(item.id || "—")}</code>\n  Origin: <code>${html(item.origin?.host || "not returned")}</code>`;
      return `• <b>${html(name)}</b> · ID: <code>${html(item.id || "—")}</code> · Dimensions: <code>${fmt(item.dimensions ?? "—")}</code>`;
    }).join("\n\n");
    return sendOrEdit(env, chatId, messageId, `${meta.icon} <b>${html(meta.label)}</b>\nمجموع: <b>${list.length}</b> · صفحه ${page + 1}\n\n${details || "منبعی پیدا نشد یا این نوع دسترسی API فعال نیست."}\n\n<blockquote>محتوای namespace، مقادیر KV، فایل‌های R2 و داده‌های داخل DB خوانده نمی‌شوند؛ فقط metadata و لینک داشبورد. آمار دقیق مصرف ممکن است از این listing endpoint قابل استخراج نباشد.</blockquote>`, kb(rows));
  } catch (err) {
    return sendOrEdit(env, chatId, messageId, apiErrorText(meta.label, err) + `\n\n<a href="${attr(storageDashboardUrl(env, type))}">Open ${html(meta.label)} dashboard</a>`, kb([
      [urlBtn("Open dashboard", storageDashboardUrl(env, type))],
      [cb("🗄️ Categories", "cf:storage"), cb("🏠 Main menu", "home")],
    ]));
  }
}

async function showStorageItem(env, chatId, type, target, messageId) {
  if (type === "pages") {
    try {
      const base = `/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/pages/projects/${encodeURIComponent(target)}`;
      const [p, deploymentsResult] = await Promise.all([
        cfApi(env, base),
        cfList(env, `${base}/deployments?per_page=3`, ["deployments"]).catch((e) => ({ __error: shortError(e) })),
      ]);
      const domains = p.domains || [];
      const liveUrl = domains[0] ? `https://${domains[0]}` : p.subdomain ? `https://${p.subdomain}` : "https://dash.cloudflare.com";
      const deployments = Array.isArray(deploymentsResult) ? deploymentsResult : [];
      const deploymentText = deploymentsResult?.__error ? `Unavailable (${html(deploymentsResult.__error)})` : deployments.length ? deployments.slice(0, 3).map((d) => `• <code>${html(d.environment || "deployment")}</code> · <code>${html(d.latest_stage?.status || d.status || "unknown")}</code> · ${fmtDate(d.created_on)}\n  ${d.url ? `<a href="${attr(d.url)}">Open deployment</a>` : html(d.id || "deployment")}`).join("\n") : "No deployment details returned.";
      return sendOrEdit(env, chatId, messageId, `🌐 <b>Cloudflare Pages · ${html(p.name || target)}</b>\n\nProduction branch: <code>${html(p.production_branch || "—")}</code>\nCreated: <code>${fmtDate(p.created_on)}</code>\nUpdated: <code>${fmtDate(p.modified_on)}</code>\nDomains: ${html(domains.join(", ") || "—")}\nSubdomain: <code>${html(p.subdomain || "—")}</code>\nBuild command: <code>${html(p.build_config?.build_command || "—")}</code>\n\n<b>Recent deployments</b>\n${deploymentText}\n\n<blockquote>Deployment details are shown only if Pages Read permission and the API return them.</blockquote>`, kb([
        [urlBtn("🌐 Open site", liveUrl), urlBtn("⚙️ Project dashboard", cfPagesUrl(env))],
        [urlBtn("📜 Deployments", `${cfPagesUrl(env)}/view/${encodeURIComponent(target)}/deployments`)],
        [cb("🌐 All Pages projects", "cf:pages"), cb("🏠 Main menu", "home")],
      ]));
    } catch (err) { return sendOrEdit(env, chatId, messageId, apiErrorText(`Pages project ${target}`, err), homeKeyboard()); }
  }
  try {
    const endpoint = storageDetailPath(env, type, target);
    const detail = endpoint ? await cfApi(env, endpoint) : null;
    const safe = detail ? JSON.stringify(scrubMetadata(detail), null, 2) : "جزئیات بیشتر در endpoint جزئیات در دسترس نیست.";
    return sendOrEdit(env, chatId, messageId, `🗄️ <b>${html(STORAGE_TYPES[type]?.label || type)} · ${html(String(target))}</b>\n\n<pre>${html(truncate(safe, 2400))}</pre>\n\n<blockquote>پاسخ API قبل از نمایش فیلتر می‌شود؛ مقادیر Secret، token، connection string و هر کلید شبیه credential حذف می‌شوند. اگر detail endpoint پشتیبانی نشود، لینک داشبورد باز کن.</blockquote>`, kb([
      [urlBtn("↗️ Open dashboard", storageDashboardUrl(env, type))],
      [cb("⬅️ Storage list", `store:${type}:0`), cb("🏠 Main menu", "home")],
    ]));
  } catch (err) {
    return sendOrEdit(env, chatId, messageId, apiErrorText(`${type} item`, err), kb([[urlBtn("Open dashboard", storageDashboardUrl(env, type))], [cb("🗄️ Categories", "cf:storage"), cb("🏠 Main menu", "home")]]));
  }
}

function storageDetailPath(env, type, target) {
  const a = `/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}`;
  if (type === "d1") return `${a}/d1/database/${encodeURIComponent(target)}`;
  if (type === "r2") return `${a}/r2/buckets/${encodeURIComponent(target)}`;
  if (type === "kv") return `${a}/storage/kv/namespaces/${encodeURIComponent(target)}`;
  if (type === "queues") return `${a}/queues/${encodeURIComponent(target)}`;
  if (type === "hyperdrive") return `${a}/hyperdrive/configs/${encodeURIComponent(target)}`;
  return null;
}

function storageName(type, item) {
  if (type === "d1") return item.name || item.uuid || item.id || "D1 database";
  if (type === "r2") return item.name || "R2 bucket";
  if (type === "kv") return item.title || item.name || item.id || "KV namespace";
  if (type === "do") return item.name || item.namespace_name || item.id || "Durable Object namespace";
  if (type === "queues") return item.queue_name || item.name || item.id || "Queue";
  if (type === "hyperdrive") return item.name || item.id || "Hyperdrive config";
  return item.name || item.id || "Vectorize index";
}

async function showCloudflareLinks(env, chatId, messageId) {
  const text = `🔗 <b>Cloudflare quick links</b>\n\nلینک به بخش‌های اصلی داشبورد. اگر مسیر یک بخش در UI حساب شما متفاوت بود، از صفحه‌ی اصلی حساب وارد همان سرویس شو.`;
  return sendOrEdit(env, chatId, messageId, text, kb([
    [urlBtn("🏢 Account home", cfAccountUrl(env)), urlBtn("⚙️ Workers", cfWorkersUrl(env))],
    [urlBtn("📊 Analytics", cfAnalyticsUrl(env)), urlBtn("📜 Observability", cfObservabilityUrl(env))],
    [urlBtn("🌐 Pages", cfPagesUrl(env)), urlBtn("🪣 R2", storageDashboardUrl(env, "r2"))],
    [urlBtn("🧬 D1", storageDashboardUrl(env, "d1")), urlBtn("🗝️ KV", storageDashboardUrl(env, "kv"))],
    [urlBtn("💳 Billing", cfBillingUrl(env)), urlBtn("📨 Queues", storageDashboardUrl(env, "queues"))],
    [cb("⬅️ Cloudflare", "cf"), cb("🏠 Main menu", "home")],
  ]));
}

function cfAccountUrl(env) { return `https://dash.cloudflare.com/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID || "")}`; }
function cfWorkersUrl(env) { return `${cfAccountUrl(env)}/workers/overview`; }
function cfWorkerMetricsUrl(env) { return `${cfAccountUrl(env)}/workers/overview`; }
function cfWorkerDetailUrl(env, name) { return `${cfAccountUrl(env)}/workers/services/view/${encodeURIComponent(name)}/production`; }
function cfObservabilityUrl(env) { return `${cfAccountUrl(env)}/workers/observability`; }
function cfAnalyticsUrl(env) { return `${cfAccountUrl(env)}/analytics`; }
function cfBillingUrl(env) { return `${cfAccountUrl(env)}/billing/overview`; }
function cfPagesUrl(env) { return `${cfAccountUrl(env)}/pages`; }
function storageDashboardUrl(env, type) {
  const routes = { d1: "/d1", r2: "/r2", kv: "/workers/kv/namespaces", do: "/workers/durable-objects", queues: "/queues", hyperdrive: "/hyperdrive", vectorize: "/vectorize" };
  return `${cfAccountUrl(env)}${routes[type] || "/workers/overview"}`;
}

async function ghApi(env, path) {
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not configured");
  const res = await fetch(`${GH_API}${path}`, {
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10", "User-Agent": "DevPulse-Infra-Radar" },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}: ${data.message || res.statusText}`);
  return data;
}

async function cfApi(env, path) {
  if (!env.CLOUDFLARE_API_TOKEN) throw new Error("CLOUDFLARE_API_TOKEN is not configured");
  const res = await fetch(`${CF_API}${path}`, { headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, Accept: "application/json", "content-type": "application/json" } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    const messages = Array.isArray(data.errors) ? data.errors.map((e) => e.message || e.code).join("; ") : "";
    throw new Error(`Cloudflare API HTTP ${res.status}: ${messages || res.statusText}`);
  }
  return data.result;
}

async function cfList(env, path, preferredKeys = []) {
  const result = await cfApi(env, path);
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object") {
    for (const key of preferredKeys) if (Array.isArray(result[key])) return result[key];
    for (const value of Object.values(result)) if (Array.isArray(value)) return value;
  }
  return [];
}

async function rememberRef(env, ownerId, kind, target) {
  if (!env.DB) throw new Error("D1 binding DB is missing");
  const ref = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const expiry = Date.now() + 30 * 60_000;
  await env.DB.prepare("INSERT INTO callback_refs (ref_id, owner_id, kind, target, expires_at) VALUES (?, ?, ?, ?, ?)").bind(ref, String(ownerId), kind, String(target), expiry).run();
  return ref;
}

async function dereference(env, ref, kind, ownerId) {
  if (!env.DB || !ref) return null;
  const row = await env.DB.prepare("SELECT target FROM callback_refs WHERE ref_id = ? AND owner_id = ? AND kind = ? AND expires_at > ? LIMIT 1").bind(String(ref), String(ownerId), kind, Date.now()).first();
  return row?.target || null;
}

async function audit(env, ownerId, action) {
  if (!env.DB) return;
  await env.DB.prepare("INSERT INTO audit_events (telegram_user_id, action, created_at) VALUES (?, ?, datetime('now'))").bind(String(ownerId), String(action).slice(0, 80)).run();
  // Keep the small operational audit table bounded; no message bodies, tokens, or API responses are recorded.
  await env.DB.prepare("DELETE FROM audit_events WHERE id IN (SELECT id FROM audit_events ORDER BY id DESC LIMIT -1 OFFSET 500)").run();
  await env.DB.prepare("DELETE FROM callback_refs WHERE expires_at <= ?").bind(Date.now()).run();
}

async function tgSend(env, chatId, text, replyMarkup) {
  if (String(text).length > 4000) text = `${String(text).slice(0, 3900)}\n\n<blockquote>خروجی برای محدودیت تلگرام کوتاه شده است.</blockquote>`;
  const body = { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true };
  if (replyMarkup) body.reply_markup = replyMarkup;
  return tgCall(env, "sendMessage", body);
}

async function tgEdit(env, chatId, messageId, text, replyMarkup) {
  if (String(text).length > 4000) text = `${String(text).slice(0, 3900)}\n\n<blockquote>خروجی برای محدودیت تلگرام کوتاه شده است.</blockquote>`;
  const body = { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", disable_web_page_preview: true };
  if (replyMarkup) body.reply_markup = replyMarkup;
  try { return await tgCall(env, "editMessageText", body); }
  catch (err) {
    if (/message is not modified/i.test(shortError(err))) return null;
    return tgSend(env, chatId, text, replyMarkup);
  }
}

async function tgCall(env, method, body) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  const res = await fetch(`${TG_API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(`Telegram API ${method} failed: ${data.description || res.status}`);
  return data.result;
}

async function answerCallback(env, callbackId) {
  return tgCall(env, "answerCallbackQuery", { callback_query_id: callbackId });
}

async function sendOrEdit(env, chatId, messageId, text, keyboard) {
  if (messageId) return tgEdit(env, chatId, messageId, text, keyboard);
  return tgSend(env, chatId, text, keyboard);
}

async function withBusy(fn) {
  try { return await fn(); } catch (err) { return apiErrorText("Request", err); }
}

function apiErrorText(label, err) {
  return `⚠️ <b>${html(label)} قابل‌دسترسی نیست</b>\n<blockquote>${html(shortError(err))}</blockquote>\n\nدلیل متداول: مجوز Read مربوط به همان سرویس روی API token فعال نیست، شناسه حساب/ریپو نادرست است یا API برای این منبع داده‌ای برنمی‌گرداند. از لینک داشبورد هم می‌توانی بررسی کنی.`;
}

function safeError(err) { return { message: shortError(err), name: err?.name || "Error" }; }
function shortError(err) { return String(err?.message || err || "Unknown error").replace(/[\r\n\t]+/g, " ").slice(0, 260); }
function html(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
function attr(value) { return html(value); }
function fmt(value) { if (value === null || value === undefined || value === "") return "—"; if (typeof value === "number") return value.toLocaleString("en-US"); return html(value); }
function fmtDate(value) { if (!value) return "—"; const date = new Date(value); return Number.isNaN(date.getTime()) ? html(value) : date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC"); }
function truncate(value, max = 40) { const str = String(value ?? ""); return str.length > max ? `${str.slice(0, max - 1)}…` : str; }
function clampPage(value) { const num = Number.parseInt(value, 10); return Number.isFinite(num) ? Math.max(0, Math.min(1000, num)) : 0; }
function statusEmoji(conclusion, status) { if (conclusion === "success" || status === "success") return "✅"; if (["failure", "timed_out", "cancelled", "action_required"].includes(conclusion)) return "❌"; if (status === "in_progress" || status === "queued") return "⏳"; return "ℹ️"; }
function inferredGithubPagesUrl(repo) { const owner = repo.owner?.login || String(repo.full_name || "").split("/")[0]; const name = repo.name || String(repo.full_name || "").split("/")[1]; return name?.toLowerCase() === owner?.toLowerCase() ? `https://${owner}.github.io/` : `https://${owner}.github.io/${name}/`; }
function scrubMetadata(value) {
  if (Array.isArray(value)) return value.map(scrubMetadata);
  if (!value || typeof value !== "object") return value;
  const out = {};
  const sensitive = /(secret|token|password|credential|private.?key|connection.?string|api.?key|auth)/i;
  for (const [key, val] of Object.entries(value)) {
    if (sensitive.test(key)) out[key] = "[redacted]";
    else if (typeof val === "string" && /(Bearer\s+|gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)/i.test(val)) out[key] = "[redacted]";
    else out[key] = scrubMetadata(val);
  }
  return out;
}
async function mapLimit(items, limit, mapper) {
  const result = new Array(items.length); let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) { const i = next++; if (i >= items.length) return; result[i] = await mapper(items[i], i); }
  });
  await Promise.all(workers); return result;
}
function cb(text, data) { return { text, callback_data: data }; }
function urlBtn(text, url) { return { text, url }; }
function kb(rows) { return { inline_keyboard: rows }; }
function json(value, status = 200) { return new Response(JSON.stringify(value, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } }); }
