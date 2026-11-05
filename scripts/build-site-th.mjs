// Builds the Thai website (site/th/index.html) from the English page (site/index.html).
//
// Run: node scripts/build-site-th.mjs
// The Pages workflow runs it on every deploy; site/th/ is not committed.
//
// Each pair is [English, Thai]. Every English string must still exist in site/index.html,
// otherwise the build fails, so a changed English text can't silently leave the Thai page stale.
// New English text that has no pair yet stays in English: add a pair for it here.
// The app drawing in the hero stays in English on purpose, because the app itself is English.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const SRC = new URL("../site/index.html", import.meta.url);
const OUT_DIR = new URL("../site/th/", import.meta.url);
const BASE = "https://oxth.github.io/retrans/";

const pairs = [
  // Head
  ['<html lang="en">', '<html lang="th">'],
  [
    "<title>Retrans — free i18n translation editor for next-i18next &amp; Paraglide</title>",
    "<title>Retrans — โปรแกรมแก้ไขไฟล์แปลภาษา (i18n) ฟรี สำหรับ next-i18next และ Paraglide</title>",
  ],
  [
    'content="Retrans is a free desktop app for editing next-i18next, Paraglide, TypeScript and Figma translations, with local or cloud AI translation. macOS, Windows and Linux."',
    'content="Retrans แอปเดสก์ท็อปฟรีสำหรับแก้ไขไฟล์แปลภาษา next-i18next, Paraglide, TypeScript และ Figma พร้อม AI ช่วยแปลทั้งแบบในเครื่องและบนคลาวด์ ใช้ได้บน macOS, Windows และ Linux"',
  ],
  [`<link rel="canonical" href="${BASE}">`, `<link rel="canonical" href="${BASE}th/">`],
  ['<meta property="og:locale" content="en_US">', '<meta property="og:locale" content="th_TH">'],
  ['<meta property="og:locale:alternate" content="th_TH">', '<meta property="og:locale:alternate" content="en_US">'],
  [`<meta property="og:url" content="${BASE}">`, `<meta property="og:url" content="${BASE}th/">`],
  [
    'content="Retrans — translation files, without the pain"',
    'content="Retrans — จัดการไฟล์แปลภาษา ง่าย ไม่ปวดหัว"',
  ],
  [
    'content="Edit next-i18next, Paraglide, TypeScript and Figma translations in one grid. Free, offline-first, with local or cloud AI."',
    'content="แก้ไขคำแปล next-i18next, Paraglide, TypeScript และ Figma ในตารางเดียว ฟรี ใช้งานออฟไลน์ได้ พร้อม AI ช่วยแปลทั้งในเครื่องและบนคลาวด์"',
  ],
  [
    'content="Retrans: translation files, without the pain. A grid of translation keys in English and Thai with one missing Thai translation highlighted."',
    'content="Retrans: จัดการไฟล์แปลภาษา ง่าย ไม่ปวดหัว ตารางคีย์คำแปลภาษาอังกฤษและภาษาไทย โดยมีคำแปลภาษาไทยที่ขาดหายไปหนึ่งช่องถูกไฮไลต์ไว้"',
  ],
  // Files one level up
  ['"icon.svg"', '"../icon.svg"'],
  ['"icon-256.png"', '"../icon-256.png"'],
  ['"apple-touch-icon.png"', '"../apple-touch-icon.png"'],
  ['fetch("CHANGELOG.md")', 'fetch("../CHANGELOG.md")'],

  // Header
  [">Skip to content<", ">ข้ามไปที่เนื้อหา<"],
  ['aria-label="Main"', 'aria-label="เมนูหลัก"'],
  ['aria-label="Footer"', 'aria-label="ส่วนท้าย"'],
  ['<a href="#features">Features</a>', '<a href="#features">ฟีเจอร์</a>'],
  ['<a href="#install">Install</a>', '<a href="#install">ติดตั้ง</a>'],
  ['<a href="#changelog">Changelog</a>', '<a href="#changelog">มีอะไรใหม่</a>'],
  ['aria-label="Language: English"', 'aria-label="ภาษา: ไทย"'],
  ["<span>English</span>", "<span>ไทย</span>"],
  [
    '<a href="./" hreflang="en" lang="en" aria-current="page">',
    '<a href="../" hreflang="en" lang="en">',
  ],
  [
    '<a href="th/" hreflang="th" lang="th">',
    '<a href="./" hreflang="th" lang="th" aria-current="page">',
  ],

  // Hero
  [
    '<b>New</b><span id="pill-text">Cloud and agent AI, Figma Variables, tabs</span>',
    '<b>ใหม่</b><span id="pill-text">AI บนคลาวด์และเอเจนต์, Figma Variables, แท็บ</span>',
  ],
  [
    "<h1>Translation files, <span>without the pain.</span></h1>",
    "<h1>ไฟล์แปลภาษา <span>จัดการง่าย ไม่ปวดหัว</span></h1>",
  ],
  [
    '<p class="lead">A free desktop app for editing next-i18next, Paraglide, TypeScript and Figma translations in one grid, with local or cloud AI to fill the gaps.</p>',
    '<p class="lead">แอปเดสก์ท็อปฟรีสำหรับแก้ไขคำแปล next-i18next, Paraglide, TypeScript และ Figma ในตารางเดียว พร้อม AI ทั้งในเครื่องและบนคลาวด์ช่วยเติมคำแปลที่ยังขาด</p>',
  ],
  [
    "Download for macOS<small>Apple Silicon (M1 and later)</small>",
    "ดาวน์โหลดสำหรับ macOS<small>Apple Silicon (M1 ขึ้นไป)</small>",
  ],
  ["Download for macOS<small>Apple Silicon</small>", "ดาวน์โหลดสำหรับ macOS<small>Apple Silicon</small>"],
  [
    "Download for Windows<small>Windows 10 and 11 (64-bit)</small>",
    "ดาวน์โหลดสำหรับ Windows<small>Windows 10 และ 11 (64 บิต)</small>",
  ],
  ["Download for Windows<small>Windows 10 and 11</small>", "ดาวน์โหลดสำหรับ Windows<small>Windows 10 และ 11</small>"],
  ["Download for Linux<small>AppImage, 64-bit</small>", "ดาวน์โหลดสำหรับ Linux<small>AppImage, 64 บิต</small>"],
  ["Download for Linux<small>AppImage</small>", "ดาวน์โหลดสำหรับ Linux<small>AppImage</small>"],
  ['<span id="version">Latest release</span>', '<span id="version">รุ่นล่าสุด</span>'],
  [">All releases</a>", ">ทุกรุ่น</a>"],
  [">Download for Intel Mac</a>", ">ดาวน์โหลดสำหรับ Mac ชิป Intel</a>"],
  ["</svg>Free, no account</li>", "</svg>ฟรี ไม่ต้องสมัครบัญชี</li>"],
  ["</svg>Works offline</li>", "</svg>ใช้งานออฟไลน์ได้</li>"],
  ["</svg>No telemetry</li>", "</svg>ไม่เก็บข้อมูลการใช้งาน</li>"],
  ["</svg>Updates itself</li>", "</svg>อัปเดตตัวเองอัตโนมัติ</li>"],
  [
    'aria-label="The Retrans window: a sidebar with per-language progress, and a grid of keys with English, Thai and German translations. Each translation has a status dot, one cell is missing, one needs review, and one is being edited with an AI suggestion."',
    'aria-label="หน้าต่าง Retrans: แถบด้านข้างแสดงความคืบหน้าของแต่ละภาษา และตารางคีย์พร้อมคำแปลภาษาอังกฤษ ไทย และเยอรมัน ทุกคำแปลมีจุดบอกสถานะ มีหนึ่งช่องที่ยังไม่แปล หนึ่งช่องที่ต้องตรวจทาน และหนึ่งช่องที่กำลังแก้ไขพร้อมคำแนะนำจาก AI"',
  ],

  // Formats
  ["<p>Opens the translation files you already have</p>", "<p>เปิดไฟล์แปลภาษาที่คุณมีอยู่แล้วได้ทันที</p>"],
  ["<li>TypeScript locale modules</li>", "<li>โมดูลภาษาแบบ TypeScript</li>"],

  // Features
  ['<p class="eyebrow">Features</p>', '<p class="eyebrow">ฟีเจอร์</p>'],
  ["<h2>Everything your translations need</h2>", "<h2>ครบทุกอย่างที่งานแปลต้องการ</h2>"],
  [
    '<p class="sub">One grid for every key and language. Missing translations are impossible to miss, and saving changes only what you edited.</p>',
    '<p class="sub">ทุกคีย์ทุกภาษาอยู่ในตารางเดียว คำแปลที่ขาดหายไปเห็นได้ทันที และการบันทึกจะเปลี่ยนเฉพาะส่วนที่คุณแก้ไขเท่านั้น</p>',
  ],
  ['<span class="tag">New in 0.2</span>', '<span class="tag">ใหม่ใน 0.2</span>'],
  ["<h3>JSON and TypeScript</h3>", "<h3>JSON และ TypeScript</h3>"],
  [
    "<p>Open next-i18next and Paraglide projects directly, or import TypeScript locale modules into a workspace that syncs when your code changes and writes back a minimal diff.</p>",
    "<p>เปิดโปรเจกต์ next-i18next และ Paraglide ได้โดยตรง หรือนำเข้าโมดูลภาษาแบบ TypeScript เป็นเวิร์กสเปซที่ซิงก์ตามโค้ดของคุณ และเขียนกลับด้วย diff ที่เล็กที่สุด</p>",
  ],
  [
    "<p>Open Figma <code>.tokens.json</code> exports, translate them, link them to your code keys, and export back. Only the text changes.</p>",
    "<p>เปิดไฟล์ <code>.tokens.json</code> ที่ส่งออกจาก Figma แปล เชื่อมกับคีย์ในโค้ด แล้วส่งออกกลับไป โดยเปลี่ยนเฉพาะข้อความเท่านั้น</p>",
  ],
  ["<h3>Local or cloud AI ", "<h3>AI ในเครื่องหรือบนคลาวด์ "],
  [
    "<p>A built-in model runs entirely on your computer. Or use OpenAI, Claude, any OpenAI-compatible API, or an AI agent you already have (Claude Code, Codex, Gemini CLI).</p>",
    "<p>โมเดลในตัวทำงานบนเครื่องของคุณทั้งหมด หรือจะใช้ OpenAI, Claude, API ที่รองรับรูปแบบ OpenAI หรือเอเจนต์ AI ที่คุณมีอยู่แล้ว (Claude Code, Codex, Gemini CLI) ก็ได้</p>",
  ],
  ["<h3>Many languages at once ", "<h3>แปลหลายภาษาในครั้งเดียว "],
  [
    "<p>Translate every missing string in all your languages in one run, with your own instructions for tone and terms.</p>",
    "<p>แปลข้อความที่ยังขาดในทุกภาษาได้ในรอบเดียว พร้อมกำหนดคำสั่งเรื่องน้ำเสียงและคำศัพท์ได้เอง</p>",
  ],
  ["<h3>Review status that travels</h3>", "<h3>สถานะการตรวจทานที่แชร์ได้</h3>"],
  [
    "<p>Every translation shows whether it's missing, waiting for review or reviewed, and flags it when the source text changes. Status lives in <code>.retrans/</code> and is shared through git.</p>",
    "<p>ทุกคำแปลบอกสถานะว่ายังไม่แปล รอตรวจทาน หรือตรวจทานแล้ว และแจ้งเตือนเมื่อข้อความต้นฉบับเปลี่ยน สถานะเก็บไว้ใน <code>.retrans/</code> และแชร์ผ่าน git ได้</p>",
  ],
  ["<h3>Tabs, auto-save, undo</h3>", "<h3>แท็บ บันทึกอัตโนมัติ และย้อนกลับ</h3>"],
  [
    "<p>Keep several projects open, never lose an edit, and undo anything, including a whole AI translation run.</p>",
    "<p>เปิดหลายโปรเจกต์พร้อมกัน งานที่แก้ไม่หาย และย้อนกลับได้ทุกอย่าง รวมถึงการแปลด้วย AI ทั้งรอบ</p>",
  ],
  ["<h3>Translator packages</h3>", "<h3>แพ็กเกจสำหรับนักแปล</h3>"],
  [
    "<p>Send a <code>.zip</code> to a translator. They open it in Retrans and send it back, and you import their work with a clear view of what changed.</p>",
    "<p>ส่งไฟล์ <code>.zip</code> ให้นักแปล เขาเปิดใน Retrans แล้วส่งกลับมา คุณนำเข้างานได้พร้อมเห็นชัดว่าอะไรเปลี่ยนไปบ้าง</p>",
  ],
  ["<h3>Your text stays yours</h3>", "<h3>ข้อความของคุณเป็นของคุณ</h3>"],
  [
    "<p>No account, no telemetry. Text leaves your computer only if you choose a cloud provider, and Retrans asks first. API keys live in your system keychain.</p>",
    "<p>ไม่ต้องมีบัญชี ไม่เก็บข้อมูลการใช้งาน ข้อความจะออกจากเครื่องก็ต่อเมื่อคุณเลือกผู้ให้บริการบนคลาวด์ และ Retrans จะถามก่อนเสมอ ส่วนคีย์ API เก็บไว้ในที่เก็บรหัสผ่านของระบบ</p>",
  ],

  // Install
  ['<p class="eyebrow">Install</p>', '<p class="eyebrow">ติดตั้ง</p>'],
  ["<h2>Up and running in a minute</h2>", "<h2>พร้อมใช้งานในหนึ่งนาที</h2>"],
  [
    '<p class="sub">Download, open, and point Retrans at your project folder.</p>',
    '<p class="sub">ดาวน์โหลด เปิดแอป แล้วเลือกโฟลเดอร์โปรเจกต์ของคุณ</p>',
  ],
  [
    "<li>Open the downloaded <code>.dmg</code> and drag <strong>Retrans</strong> into Applications.</li>",
    "<li>เปิดไฟล์ <code>.dmg</code> ที่ดาวน์โหลดมา แล้วลาก <strong>Retrans</strong> ไปไว้ในโฟลเดอร์ Applications</li>",
  ],
  [
    "<li>The first time you open it, macOS may say it can't check the app. Open <strong>System Settings → Privacy &amp; Security</strong> and choose <strong>Open Anyway</strong>, or right-click Retrans in Applications and choose <strong>Open</strong>.</li>",
    "<li>ครั้งแรกที่เปิด macOS อาจแจ้งว่าตรวจสอบแอปไม่ได้ ให้ไปที่ <strong>System Settings → Privacy &amp; Security</strong> แล้วเลือก <strong>Open Anyway</strong> หรือคลิกขวาที่ Retrans ใน Applications แล้วเลือก <strong>Open</strong></li>",
  ],
  [
    "<li>Run the downloaded <code>Retrans_…_x64-setup.exe</code>.</li>",
    "<li>เปิดไฟล์ <code>Retrans_…_x64-setup.exe</code> ที่ดาวน์โหลดมา</li>",
  ],
  [
    "<li>If SmartScreen says it protected your PC, click <strong>More info → Run anyway</strong>.</li>",
    "<li>ถ้า SmartScreen แจ้งว่าได้ปกป้องพีซีของคุณ ให้คลิก <strong>More info → Run anyway</strong></li>",
  ],
  [
    "<span>Retrans updates itself on macOS, Windows and with the Linux AppImage: once installed, new versions are offered inside the app.</span>",
    "<span>Retrans อัปเดตตัวเองได้บน macOS, Windows และ AppImage บน Linux เมื่อติดตั้งแล้ว เวอร์ชันใหม่จะแจ้งให้อัปเดตภายในแอป</span>",
  ],

  [
    "<li>Make the downloaded AppImage executable with <code>chmod +x Retrans_*.AppImage</code>, then run it. If it doesn't start, install <code>libfuse2</code> (<code>libfuse2t64</code> on Ubuntu 24.04).</li>",
    "<li>ทำให้ไฟล์ AppImage ที่ดาวน์โหลดมารันได้ด้วยคำสั่ง <code>chmod +x Retrans_*.AppImage</code> แล้วเปิดใช้งาน ถ้าเปิดไม่ขึ้น ให้ติดตั้ง <code>libfuse2</code> (บน Ubuntu 24.04 ใช้ <code>libfuse2t64</code>)</li>",
  ],
  [
    "<li>On Debian or Ubuntu you can use the <a data-os=\"deb\" href=\"https://github.com/oxth/retrans/releases/latest\">.deb package</a> instead: <code>sudo apt install ./Retrans_*_amd64.deb</code>. It doesn't update itself; install the newer .deb to update.</li>",
    "<li>บน Debian หรือ Ubuntu จะใช้<a data-os=\"deb\" href=\"https://github.com/oxth/retrans/releases/latest\">แพ็กเกจ .deb</a>แทนก็ได้: <code>sudo apt install ./Retrans_*_amd64.deb</code> แบบนี้จะไม่อัปเดตตัวเอง ต้องติดตั้งไฟล์ .deb เวอร์ชันใหม่เมื่อต้องการอัปเดต</li>",
  ],

  // Changelog (the entries themselves come from CHANGELOG.md and stay in English)
  ['<p class="eyebrow">Changelog</p>', '<p class="eyebrow">บันทึกการเปลี่ยนแปลง</p>'],
  ["<h2>What's new</h2>", "<h2>มีอะไรใหม่</h2>"],
  [
    '<p class="sub">What\'s new, improved and fixed in each version. Also in <a href="https://github.com/oxth/retrans/blob/main/CHANGELOG.md">CHANGELOG.md</a>.</p>',
    '<p class="sub">สิ่งที่เพิ่ม ปรับปรุง และแก้ไขในแต่ละเวอร์ชัน (เป็นภาษาอังกฤษ) ดูได้ที่ <a href="https://github.com/oxth/retrans/blob/main/CHANGELOG.md">CHANGELOG.md</a> เช่นกัน</p>',
  ],
  ['<p class="meta">Loading…</p>', '<p class="meta">กำลังโหลด…</p>'],
  [">Show older versions</button>", ">แสดงเวอร์ชันก่อนหน้า</button>"],

  // Closing call to action and footer
  ["<h2>Give your translations one good home</h2>", "<h2>ให้งานแปลของคุณมีที่อยู่ที่ดี</h2>"],
  [
    "<p>Free for macOS, Windows and Linux. No account, nothing to set up.</p>",
    "<p>ฟรีสำหรับ macOS, Windows และ Linux ไม่ต้องมีบัญชี ไม่ต้องตั้งค่าอะไร</p>",
  ],
  [">Report a problem</a>", ">แจ้งปัญหา</a>"],
  ['<a href="https://github.com/oxth/retrans/releases">Releases</a>', '<a href="https://github.com/oxth/retrans/releases">ทุกรุ่น</a>'],
  ["<span>Free and open source · ", "<span>ฟรีและโอเพนซอร์ส · "],
  [">MIT License</a>", ">สัญญาอนุญาต MIT</a>"],

  // Script text
  ["toLocaleDateString(undefined,", 'toLocaleDateString("th-TH",'],
  ['`Version ${v}${date ? " · " + date : ""}`', '`เวอร์ชัน ${v}${date ? " · " + date : ""}`'],
  [
    "`Version ${v}: cloud and agent AI, Figma Variables, tabs`",
    "`เวอร์ชัน ${v}: AI บนคลาวด์และเอเจนต์, Figma Variables, แท็บ`",
  ],
  ["Version ${esc(v[1])}", "เวอร์ชัน ${esc(v[1])}"],
  ['<span class="latest">Latest</span>', '<span class="latest">ล่าสุด</span>'],
  [
    "'<p class=\"meta\">See <a href=\"https://github.com/oxth/retrans/blob/main/CHANGELOG.md\">CHANGELOG.md</a> on GitHub.</p>'",
    "'<p class=\"meta\">ดู <a href=\"https://github.com/oxth/retrans/blob/main/CHANGELOG.md\">CHANGELOG.md</a> บน GitHub</p>'",
  ],
];

let html = readFileSync(SRC, "utf8");
const stale = [];
for (const [en, th] of pairs) {
  if (!html.includes(en)) stale.push(en);
  else html = html.split(en).join(th);
}
if (stale.length) {
  console.error(`site/index.html no longer contains ${stale.length} English string(s) the Thai page translates.`);
  console.error("Update their pairs in scripts/build-site-th.mjs:\n");
  for (const s of stale) console.error("  " + s.slice(0, 140));
  process.exit(1);
}
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(new URL("index.html", OUT_DIR), html);
console.log(`Wrote site/th/index.html (${pairs.length} strings translated).`);
