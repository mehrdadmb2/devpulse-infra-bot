# راه‌اندازی DevPulse Infra Radar (راهنمای فارسی)

این راهنما برای ویندوز، GitHub GUI و استقرار مستقیم با Wrangler نوشته شده است. ربات خصوصی است و برای GitHub/Cloudflare فقط مجوزهای Read می‌گیرد. هیچ توکن واقعی را در فایل‌های ریپو قرار نده.

## ۱) مشخصات و هویت پیشنهادی

- **نام ربات:** `DevPulse | Infra Radar`
- **یوزرنیم پیشنهادی ربات:** `MehrdadInfraRadarBot` — آزاد بودن این نام باید داخل BotFather بررسی شود؛ اگر گرفته شده بود یک پسوند کوتاه اضافه کن.
- **About کوتاه:** `Personal read-only GitHub + Cloudflare command center. Repos, Pages, Workers, storage, metrics & reports.`
- **Description:** `A private read-only command center for GitHub and Cloudflare. Browse repository metadata, GitHub Pages, Actions runs, Cloudflare Workers and Pages, storage inventories, available analytics, and official report/log links. No repository or infrastructure mutation, deployment, deletion, secret retrieval, KV value reads, or R2 object downloads.`
- **Repository name:** `devpulse-infra-bot`
- **Repository About:** `Private read-only Telegram command center for GitHub and Cloudflare: repository & Pages insights, Worker analytics, storage inventory and direct report/log links. Cloudflare Worker + D1; no KV dependency.`
- **Cloudflare Worker name:** `mehrdad-devpulse-bot`

### پرامپت بنر ربات (برای تصویرساز)

```text
Create a premium cinematic 16:9 Telegram bot banner for “DevPulse | Infra Radar”, a private developer infrastructure command center for GitHub and Cloudflare. Dark obsidian / midnight navy background, restrained GitHub graphite and Cloudflare orange accents with electric cyan telemetry lines, an elegant central radar made of thin concentric rings, floating translucent glass panels with abstract repository nodes, serverless edge nodes and analytics traces, subtle dashboard grids, tasteful bloom, realistic depth, precise soft shadows, high-end SaaS / cyber-infrastructure aesthetic, crisp visual hierarchy, clean negative space in the center-left for the title “DevPulse”, small subtitle “GITHUB × CLOUDFLARE • READ-ONLY”, no real brand logos, no fake UI text other than the specified title/subtitle, no watermark, polished professional art direction.
```

### پرامپت آواتار ربات

```text
Create a premium square 1:1 minimalist app avatar for “DevPulse | Infra Radar”. One iconic radar pulse ring merging with a small serverless node graph and a subtle pulse/check mark, geometric and immediately recognizable at 64×64 pixels. Dark midnight navy background, graphite glass material, electric cyan core glow with a small controlled Cloudflare-orange highlight, dimensional 3D enamel/glass finish, crisp silhouette, strong contrast, refined lighting, soft realistic shadow, centered composition, no words, no letters, no official logos, no watermark, not overly complex.
```

## ۲) ساخت بات در Telegram

1. در تلگرام وارد **@BotFather** شو و دستور `/newbot` را بفرست.
2. نام `DevPulse | Infra Radar` را بده.
3. اگر یوزرنیم پیشنهادی آزاد بود `MehrdadInfraRadarBot` را ثبت کن. یوزرنیم باید به `bot` ختم شود.
4. توکن را فقط برای خودت نگه دار؛ آن را در GitHub، این چت، فایل README یا اسکرین‌شات عمومی نگذار.
5. از BotFather با `/setdescription` و `/setabouttext` متن‌های بالا را ثبت کن. با `/setuserpic` آواتار و با ابزارهای فعلی BotFather/تلگرام بنر را تنظیم کن؛ پشتیبانی از تصویر بنر ممکن است بسته به نوع پروفایل/رابط تلگرام متفاوت باشد.
6. برای پیدا کردن **شناسه عددی Telegram**، از یک ربات معتبر نمایش User ID استفاده کن. مقدار عددی است؛ username تلگرام قابل‌جایگزینی با آن نیست.

## ۳) ساخت Fine-grained GitHub token فقط‌خواندنی

1. وارد [Fine-grained personal access tokens](https://github.com/settings/personal-access-tokens) شو و یک token جدید بساز.
2. Resource owner را `mehrdadmb2` انتخاب کن.
3. Repository access را روی **Only select repositories** برای ریپوهایی که لازم داری بگذار؛ اگر خواستی همه ریپوهای خودت را نمایش دهد، **All repositories** را انتخاب کن.
4. در Repository permissions این‌ها را روی **Read-only** بگذار:
   - `Metadata: Read` (GitHub معمولاً اجباری/خودکار است)
   - `Actions: Read` (برای آخرین workflow runs)
   - `Pages: Read` (برای پیکربندی و buildهای GitHub Pages)
   - `Administration: Read` (برای endpointهای traffic؛ حساب تو باید روی ریپو دسترسی لازم داشته باشد)
   - `Contents: Read` فقط اگر بعداً قصد افزودن نمایش اطلاعات فایل/README داشتی؛ این نسخه برای فهرست و آمار اصلی محتوا را دانلود نمی‌کند.
5. هیچ permission را روی Write نگذار. Token را بساز و فقط در مرحله‌ی `wrangler secret put GITHUB_TOKEN` وارد کن.

نکته: آمار Traffic گیت‌هاب معمولاً فقط ۱۴ روز اخیر را پوشش می‌دهد و endpoint ممکن است برای یک ریپو یا token با `403` برگردد؛ ربات این وضعیت را صریح اعلام می‌کند.

## ۴) ساخت Cloudflare API token فقط‌خواندنی

1. وارد [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens) شو و **Create Custom Token** را انتخاب کن.
2. فقط روی Account مربوط به خودت (همان Account ID درج‌شده در `wrangler.toml`) دسترسی بده.
3. تنها permissionهای **Read** لازم را انتخاب کن. نام دقیق permissionها در رابط ممکن است بسته به سرویس تغییر جزئی داشته باشد:
   - Account / Account Settings: Read (برای metadata حساب، اگر موجود باشد)
   - Account Analytics: Read (برای GraphQL Workers Analytics)
   - Workers Scripts: Read (برای فهرست و تنظیمات Workerها)
   - Pages: Read
   - D1: Read
   - Workers KV Storage: Read (فقط نام/metadata namespaceها؛ مقدار KV خوانده نمی‌شود)
   - Workers R2 Storage: Read (فقط نام/metadata bucketها؛ فایل‌ها خوانده نمی‌شوند)
   - برای Durable Objects namespaces، مستندات endpoint فعلی `Workers Scripts: Read` را به‌عنوان permission پذیرفته‌شده اعلام می‌کند؛ در صورت استفاده از این سرویس‌ها همان دسترسی را فعال کن. برای Queues: `Queues: Read`، Hyperdrive: `Hyperdrive: Read` و Vectorize: `Vectorize: Read` را فقط در صورت نیاز اضافه کن.
   - Zones / Workers Routes: Read در صورت نیاز به route inventory در نسخه‌های بعدی
4. **هیچ permission با عنوان Write/Edit/Delete/Deploy را اضافه نکن.** به‌خصوص این ربات `Workers Observability Write` را نمی‌خواهد؛ لاگ‌ها با لینک مستقیم داشبورد باز می‌شوند.
5. Token را فقط در `wrangler secret put CLOUDFLARE_API_TOKEN` قرار بده.

اگر یک کارت `403` داد، به‌جای دادن دسترسی نوشتنی، فقط permission متناظر Read را بررسی کن. همه سرویس‌ها برای هر حساب یا پلن فعال نیستند.

## ۵) آماده‌سازی پروژه با Wrangler

این پروژه بدون وابستگی npm در زمان اجراست.

در PowerShell پوشه‌ی پروژه را باز کن. Node.js LTS نصب باشد، سپس:

```powershell
npm install -g wrangler
npx wrangler login
npx wrangler d1 create devpulse-infra-bot-db
```

Wrangler یک `database_id` نمایش می‌دهد. فایل `wrangler.toml` را باز کن و این مقدار را جایگزین کن:

```toml
database_id = "REPLACE_WITH_D1_DATABASE_ID"
```

شناسه‌ی واقعی را بین کوتیشن بگذار و فایل را ذخیره کن. Account ID ریشه و `CLOUDFLARE_ACCOUNT_ID` در بخش `[vars]` بر اساس لینک داشبوردی است که خودت دادی؛ اگر در حساب دیگری Worker می‌سازی، هر دو را یکسان اصلاح کن. اگر نام Worker از قبل در آن حساب وجود دارد، `name` را به یک نام آزاد تغییر بده.

### ساخت جدول‌های D1

```powershell
npx wrangler d1 migrations apply devpulse-infra-bot-db --remote
```

D1 فقط callbackهای کوتاه‌مدت دکمه‌ها و audit محدود را ذخیره می‌کند؛ هیچ پاسخ GitHub/Cloudflare، محتوای پیام یا credential ذخیره نمی‌شود. از KV استفاده نشده است.

## ۶) افزودن Secretها

هر دستور را جداگانه اجرا کن و هنگام درخواست Wrangler مقدار را paste کن. مقدارها در فایل پروژه قرار نمی‌گیرند:

```powershell
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_OWNER_ID
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put CLOUDFLARE_API_TOKEN
```

برای `TELEGRAM_OWNER_ID` فقط شناسه عددی تلگرام خودت را وارد کن.

برای `TELEGRAM_WEBHOOK_SECRET` از یک رشته تصادفی طولانی با حروف انگلیسی، عدد، `_` یا `-` استفاده کن؛ نمونه‌ی زیر فقط نمونه است و عیناً استفاده‌اش نکن:

```text
REPLACE_WITH_A_RANDOM_40_CHAR_SECRET
```

**مهم:** همان مقدار Webhook Secret را برای مرحله‌ی بعد هم لازم داری. آن را در password manager شخصی نگه دار. اگر فراموشش کردی، یک secret جدید بساز و هم در Wrangler و هم در `setWebhook` به‌روزرسانی کن.

## ۷) استقرار Worker

```powershell
npx wrangler deploy
```

خروجی معمولاً آدرسی مشابه این می‌دهد:

```text
https://mehrdad-devpulse-bot.<YOUR-WORKERS-SUBDOMAIN>.workers.dev
```

آدرس واقعی را از خروجی Wrangler کپی کن و در دستورات بعدی جایگزین `YOUR_WORKER_URL` کن. سپس در مرورگر باز کن:

```text
YOUR_WORKER_URL/health
```

باید JSON وضعیت نشان دهد و مقدار Secretها را افشا نکند.

## ۸) ثبت Webhook تلگرام

در PowerShell این متغیرها را با مقدار واقعی خودت تنظیم کن. مقدار توکن ربات را فقط روی دستگاه خودت وارد کن:

```powershell
$TOKEN = "PASTE_TELEGRAM_BOT_TOKEN_HERE"
$WORKER_URL = "https://mehrdad-devpulse-bot.YOUR-WORKERS-SUBDOMAIN.workers.dev"
$WEBHOOK_SECRET = "PASTE_THE_SAME_TELEGRAM_WEBHOOK_SECRET_HERE"

$body = @{
  url = "$WORKER_URL/tg/$WEBHOOK_SECRET"
  secret_token = $WEBHOOK_SECRET
  allowed_updates = @("message", "callback_query")
  drop_pending_updates = $false
} | ConvertTo-Json -Compress

Invoke-RestMethod -Method Post `
  -Uri "https://api.telegram.org/bot$TOKEN/setWebhook" `
  -ContentType "application/json" `
  -Body $body
```

پاسخ موفق باید شامل `"ok": true` باشد. این درخواست صرفاً webhook همین بات تلگرام را تنظیم می‌کند؛ روی ریپوها یا منابع Cloudflare تغییری نمی‌دهد.

برای تأیید وبهوک:

```powershell
Invoke-RestMethod -Uri "https://api.telegram.org/bot$TOKEN/getWebhookInfo"
```

## ۹) بارگذاری سورس در GitHub از داشبورد گرافیکی

1. در [GitHub](https://github.com/new) یک repository به نام `devpulse-infra-bot` بساز؛ بهتر است **Private** باشد.
2. فایل‌های همین بسته را از حالت ZIP خارج کن.
3. در ریپوی تازه **Add file → Upload files** را بزن و فایل‌های پروژه را بارگذاری کن؛ پوشه‌ی `src` و `migrations` باید با ساختار درست حفظ شوند. اگر رابط وب حفظ ساختار پوشه‌ها را سخت کرد، اول فولدرها را از طریق صفحه‌ی ریپو بساز یا از GitHub Desktop استفاده کن.
4. هیچ فایل حاوی token، `.dev.vars` یا `.env` را upload نکن.
5. این ریپو به‌صورت خودکار از GitHub deploy نمی‌شود؛ طبق خواسته‌ی تو، deployment با Wrangler از پوشه‌ی محلی انجام می‌شود. بعد از تغییر کد: `npx wrangler deploy`.

## ۱۰) استفاده از ربات

- `/start` یا `/menu` — داشبورد اصلی
- `/github` — پروفایل و نمای GitHub
- `/cloudflare` — نمای Cloudflare
- `/repo mehrdadmb2/نام-ریپو` — جزئیات یک ریپو
- `/worker نام-worker` — جزئیات یک Worker
- `/help` — راهنما

دکمه‌های inline با callbackهای کوتاه و referenceهای تصادفی D1 ساخته می‌شوند؛ callbackها بعد از ۳۰ دقیقه منقضی می‌شوند. با گرفتن یک فهرست تازه، دکمه‌های تازه دریافت می‌کنی.

## ۱۱) مواردی که عمداً انجام نمی‌دهد

- ایجاد/ویرایش/حذف ریپو، Worker، DNS، Pages، D1، KV، R2 یا هر resource دیگر.
- Deploy، تغییر secret یا variable، trigger کردن GitHub Actions، merge PR یا ایجاد Issue.
- خواندن مقادیر Secretها، KV values، اشیای R2 یا داده‌های درون دیتابیس‌های پروژه.
- اجرای query روی D1های پروژه‌های تو؛ تنها D1 متصل به خود این ربات برای callbackهای موقت و audit سبک استفاده می‌شود.
- واکشی مستقیم لاگ‌های Observability از API؛ در این طراحی فقط لینک رسمی داشبورد گذاشته شده تا مجوز `Workers Observability Write` لازم نباشد.

اگر بعداً قابلیت بیشتری خواستی، endpointها باید جداگانه بررسی شوند و هیچ permission نوشتنی برای دور زدن خطای API اضافه نشود.
