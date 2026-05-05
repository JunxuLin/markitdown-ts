import * as fs from "fs";
import * as path from "path";
import * as posixPath from "path/posix";
import { fileURLToPath } from "url";
import unzipper from "unzipper";
import { DOMParser } from "@xmldom/xmldom";
import { JSDOM } from "jsdom";
import mime from "mime-types";
import { ConverterOptions, ConverterResult, DocumentConverter } from "../types";
import { CustomTurnDown } from "../custom-turndown";

// ---------------------------------------------------------------------------
// Module-level path helpers (ESM + CJS compatible)
// ---------------------------------------------------------------------------
const _dirname =
  typeof __dirname !== "undefined"
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const EPUB_TYPE_TO_SUBDIR: Record<string, string> = {
  frontmatter: "front-matter",
  bodymatter: "chapters",
  backmatter: "back-matter"
};

const SKIP_BASENAMES = new Set(["navigation", "nav", "toc", "eula"]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface LangConfig {
  chapter_patterns?: Array<{
    regex: string;
    num_group: number;
    rest_group?: number;
    flags?: string[];
  }>;
  front_matter_titles?: string[];
  back_matter_titles?: string[];
  skip_titles?: string[];
  skip_title_patterns?: string[];
  chapter_filename_use_title?: boolean;
}

const DEFAULT_LANG_CONFIG: LangConfig = {
  chapter_patterns: [
    {
      regex: "^(?:chapter\\s+)?(\\d+)\\s*[.:]?\\s*(.+)$",
      flags: ["i"],
      num_group: 1,
      rest_group: 2
    }
  ],
  front_matter_titles: [],
  back_matter_titles: [],
  skip_titles: [],
  skip_title_patterns: [],
  chapter_filename_use_title: false
};

// ---------------------------------------------------------------------------
// Helper utilities
// ---------------------------------------------------------------------------

function normalizeLangCode(language: string): string {
  const code = language.trim().toLowerCase().replace(/_/g, "-");
  if (code.startsWith("zh")) {
    if (code.includes("hant") || code.includes("tw") || code.includes("hk") || code.includes("mo")) {
      return "zh-Hant";
    }
    return "zh-Hans";
  }
  return code.split("-")[0];
}

function loadLangConfig(language: string): LangConfig {
  const langCode = normalizeLangCode(language);
  const langFile = path.join(_dirname, "epub_languages", `${langCode}.json`);
  if (fs.existsSync(langFile)) {
    try {
      return JSON.parse(fs.readFileSync(langFile, "utf-8")) as LangConfig;
    } catch {
      return DEFAULT_LANG_CONFIG;
    }
  }
  return DEFAULT_LANG_CONFIG;
}

function romanToInt(text: string): number {
  const VALS: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  const s = text.trim().toUpperCase();
  if (!s || !Array.from(s).every((c) => c in VALS)) return 0;
  let total = 0;
  let prev = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    const v = VALS[s[i]];
    total += v >= prev ? v : -v;
    prev = v;
  }
  return total;
}

function kanjiToInt(text: string): number {
  const DIGIT: Record<string, number> = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9
  };
  const s = text.trim();
  if (s in DIGIT) return DIGIT[s];
  if (s.includes("十")) {
    const parts = s.split("十");
    const tens = parts[0] ? (DIGIT[parts[0]] ?? 1) : 1;
    const ones = parts[1] ? (DIGIT[parts[1]] ?? 0) : 0;
    return tens * 10 + ones;
  }
  return 0;
}

function normalizePythonFlags(flags: string[]): string {
  return flags
    .map((f) => {
      switch (f.toUpperCase()) {
        case "IGNORECASE": return "i";
        case "MULTILINE": return "m";
        case "DOTALL": return "s";
        case "UNICODE": return "u";
        case "VERBOSE": return "";
        case "ASCII": return "";
        default: return f.toLowerCase();
      }
    })
    .filter(Boolean)
    .join("");
}

function slugify(text: string): string {
  let s = text.toLowerCase();
  s = Buffer.from(s).toString("ascii").replace(/[^\x00-\x7F]/g, "");
  s = s.replace(/[^\w\s-]/g, "");
  s = s.replace(/[\s_]+/g, "-").replace(/^-+|-+$/g, "");
  return s;
}

function makeFilenameStem(text: string): string {
  let s = text.replace(/[/\\:*?"<>|\x00-\x1f]/g, "");
  s = s.replace(/[\s\u3000]+/g, "-").replace(/^-+|-+$/g, "");
  try {
    Buffer.from(s, "ascii").toString("ascii");
    const isAscii = Array.from(s).every((c) => c.charCodeAt(0) < 128);
    if (isAscii) {
      s = s.toLowerCase();
      s = s.replace(/[^\w-]/g, "");
      s = s.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
    }
  } catch {
    // keep as-is for non-ASCII
  }
  return s;
}

function makeCjkFilenameStem(text: string): string {
  let s = text.replace(/[\r\n]+/g, " ");
  s = s.replace(/[ \t\u3000]+/g, " ").trim();
  s = s.replace(/[/\\:*?"<>|\x00-\x1f]/g, "");
  return s.trim();
}

function getTextFromXmlNode(dom: Document | Element, tagName: string): string | null {
  const nodes = (dom as any).getElementsByTagName(tagName);
  if (nodes && nodes.length > 0) {
    const first = nodes.item ? nodes.item(0) : nodes[0];
    if (first) {
      return first.textContent?.trim() || null;
    }
  }
  return null;
}

function getAllTextsFromXmlNodes(dom: Document | Element, tagName: string): string[] {
  const nodes = (dom as any).getElementsByTagName(tagName);
  const results: string[] = [];
  if (!nodes) return results;
  const len = nodes.length ?? 0;
  for (let i = 0; i < len; i++) {
    const n = nodes.item ? nodes.item(i) : nodes[i];
    if (n && n.textContent) {
      results.push(n.textContent.trim());
    }
  }
  return results;
}

function getEpubType(htmlContent: string): string | null {
  const dom = new JSDOM(htmlContent);
  const doc = dom.window.document;
  for (const tagName of ["body", "section", "article", "div"]) {
    const el = doc.querySelector(tagName);
    if (el) {
      const val = el.getAttribute("epub:type") || el.getAttribute("data-epub-type");
      if (val) {
        for (const token of val.split(/\s+/)) {
          if (token in EPUB_TYPE_TO_SUBDIR) return token;
        }
      }
    }
  }
  return null;
}

function getChapterTitle(htmlContent: string): string {
  const dom = new JSDOM(htmlContent);
  const doc = dom.window.document;
  // 1. Semantic headings
  for (const tag of ["h1", "h2", "h3"]) {
    const h = doc.querySelector(tag);
    if (h && h.textContent?.trim()) return h.textContent.trim();
  }
  // 2. <p class="...title...">
  const paragraphs = doc.querySelectorAll("p");
  for (const p of Array.from(paragraphs)) {
    const cls = Array.from(p.classList).join(" ");
    if (/title/i.test(cls)) {
      const text = p.textContent?.trim();
      if (text) return text;
    }
  }
  // 3. <head><title>
  const headTitle = doc.title;
  if (headTitle && headTitle.trim()) return headTitle.trim();
  return "";
}

function isNoiseItem(stemHint: string, fileStem: string): boolean {
  const s = stemHint
    .toLowerCase()
    .replace(/\.[^.]+$/, "")
    .replace(/^x[-_]/, "");
  const fs = fileStem.toLowerCase();
  const sBase = s.replace(/[0-9_\- ]+$/, "");
  return SKIP_BASENAMES.has(s) || SKIP_BASENAMES.has(fs) || SKIP_BASENAMES.has(sBase);
}

function epubTypeToSubdir(
  epubType: string | null,
  stemHint: string,
  title: string,
  langConfig: LangConfig
): string {
  if (epubType && epubType in EPUB_TYPE_TO_SUBDIR) {
    return EPUB_TYPE_TO_SUBDIR[epubType];
  }

  const cfg = langConfig;

  // Title-based: check chapter patterns
  if (title) {
    for (const pat of cfg.chapter_patterns ?? []) {
      const flags = normalizePythonFlags(pat.flags ?? []);
      const re = new RegExp(pat.regex, flags);
      if (re.test(title)) return "chapters";
    }
    const titleLower = title.toLowerCase();
    for (const kw of cfg.back_matter_titles ?? []) {
      if (titleLower.includes(kw.toLowerCase())) return "back-matter";
    }
    for (const kw of cfg.front_matter_titles ?? []) {
      if (titleLower.includes(kw.toLowerCase())) return "front-matter";
    }
  }

  const FRONT_KEYWORDS = new Set([
    "cover", "cvi", "cov", "title", "tp", "htp", "halftitle", "half-title",
    "titlepage", "bookname", "copyright", "cop", "legal", "dedication", "ded",
    "acknowledgment", "acknowledgments", "ack", "foreword", "fore", "preface",
    "pre", "introduction", "intro", "epigraph", "epi", "frontmatter",
    "front-matter", "fm"
  ]);
  const BACK_KEYWORDS = new Set([
    "bibliography", "bib", "references", "ref", "index", "ind", "appendix",
    "app", "appendices", "backmatter", "back-matter", "bm", "about", "ata",
    "afterword", "aft", "glossary", "glo", "notes", "author"
  ]);

  const s = stemHint.toLowerCase().replace(/\.[^.]+$/, "").trim();
  const base = s.replace(/[0-9_\- ]+$/, "");
  if (FRONT_KEYWORDS.has(base) || FRONT_KEYWORDS.has(s)) return "front-matter";
  if (BACK_KEYWORDS.has(base) || BACK_KEYWORDS.has(s)) return "back-matter";
  for (const kw of FRONT_KEYWORDS) {
    if (s.startsWith(kw)) return "front-matter";
  }
  for (const kw of BACK_KEYWORDS) {
    if (s.startsWith(kw)) return "back-matter";
  }
  const sClean = s.replace(/^x[-_]/, "");
  const baseClean = sClean.replace(/[0-9_\- ]+$/, "");
  if (FRONT_KEYWORDS.has(baseClean) || FRONT_KEYWORDS.has(sClean)) return "front-matter";
  if (BACK_KEYWORDS.has(baseClean) || BACK_KEYWORDS.has(sClean)) return "back-matter";
  for (const kw of FRONT_KEYWORDS) {
    if (sClean.startsWith(kw)) return "front-matter";
  }
  for (const kw of BACK_KEYWORDS) {
    if (sClean.startsWith(kw)) return "back-matter";
  }
  return "chapters";
}

interface ChapterCounter {
  max: number;
  seen: Record<number, number>;
}

function mapToOutputFilename(
  title: string,
  stemHint: string,
  subdir: string,
  counter: ChapterCounter,
  langConfig: LangConfig
): string {
  const cfg = langConfig;
  const stemBase = stemHint.replace(/\.[^.]+$/, "");
  const cleanStem = stemBase.replace(/^x_/i, "");

  if (subdir === "chapters") {
    const matchTitle = title.replace(/\s+/g, " ").trim();
    for (const pat of cfg.chapter_patterns ?? []) {
      const flags = normalizePythonFlags(pat.flags ?? []);
      const re = new RegExp(pat.regex, flags);
      const m = re.exec(matchTitle);
      if (m) {
        let rawNum = m[pat.num_group];
        // Normalize fullwidth digits
        rawNum = rawNum.replace(/[０-９]/g, (c) => String(c.charCodeAt(0) - 0xff10));
        // Kanji / Roman fallback
        if (!/^\d+$/.test(rawNum)) {
          let n = kanjiToInt(rawNum);
          if (n === 0) n = romanToInt(rawNum);
          rawNum = String(n);
        }
        const num = parseInt(rawNum, 10);
        counter.max = Math.max(counter.max, num);

        if (cfg.chapter_filename_use_title && title) {
          const cjkStem = makeCjkFilenameStem(title);
          if (cjkStem) return `${cjkStem}.md`;
        }

        const occurrence = counter.seen[num] ?? 0;
        counter.seen[num] = occurrence + 1;
        const suffix = occurrence > 0 ? String.fromCharCode("b".charCodeAt(0) + occurrence - 1) : "";
        const rest =
          pat.rest_group !== undefined ? (m[pat.rest_group] ?? "").trim() : "";
        const restClean = rest.replace(/^[\u2013\u2014\u2015\-]+\s*/, "");
        const stem =
          makeFilenameStem(restClean) ||
          makeFilenameStem(title) ||
          makeFilenameStem(cleanStem) ||
          `chapter-${num}`;
        return `${String(num).padStart(2, "0")}${suffix}-${stem}.md`;
      }
    }
    // Auto-increment
    counter.max += 1;
    let num = counter.max;
    while (num in counter.seen) {
      counter.max += 1;
      num = counter.max;
    }
    counter.seen[num] = 1;
    const stem = makeFilenameStem(title || cleanStem) || `chapter-${num}`;
    return `${String(num).padStart(2, "0")}-${stem}.md`;
  } else {
    const MAX_SECTION_TITLE_LEN = 40;
    let stem: string;
    if (title && title.length <= MAX_SECTION_TITLE_LEN) {
      stem = makeFilenameStem(title) || makeFilenameStem(cleanStem);
    } else {
      stem = makeFilenameStem(cleanStem);
    }
    stem = stem || "section";
    return `${stem}.md`;
  }
}

function extractNavLinks(htmlContent: string): string[] {
  const dom = new JSDOM(htmlContent);
  const doc = dom.window.document;
  const lines: string[] = [];

  let tocNav: Element | null = null;
  // Find epub:type="toc" nav
  const navs = Array.from(doc.querySelectorAll("nav"));
  for (const nav of navs) {
    if (nav.getAttribute("epub:type") === "toc" || nav.id === "toc") {
      tocNav = nav;
      break;
    }
  }
  if (!tocNav) tocNav = doc.body || doc.documentElement;

  const topOl = tocNav?.querySelector("ol");
  if (!topOl) return lines;

  const topLis = Array.from(topOl.children).filter((c) => c.tagName === "LI");
  for (const li of topLis) {
    const a = li.querySelector("a");
    if (a) {
      const text = a.textContent?.trim();
      if (text) lines.push(`- ${text}`);
    }
  }
  return lines;
}

function injectBlockRefs(htmlContent: string): string {
  const dom = new JSDOM(htmlContent);
  const doc = dom.window.document;
  let changed = false;
  for (const li of Array.from(doc.querySelectorAll("li[id]"))) {
    const id = li.getAttribute("id");
    if (id) {
      li.append(` ^${id}`);
      changed = true;
    }
  }
  return changed ? dom.serialize() : htmlContent;
}

function rewriteEpubLinks(
  markdown: string,
  stemToOutpath: Record<string, string>,
  thisOutpath: string
): string {
  const thisDir = path.dirname(thisOutpath);

  markdown = markdown.replace(
    /\]\(([^)#/\s]+)\.x?html(#[^)]+)?\)/g,
    (_full: string, stem: string, fragment?: string) => {
      if (stem in stemToOutpath) {
        const target = stemToOutpath[stem];
        let rel = thisDir && thisDir !== "." ? path.relative(thisDir, target) : target;
        rel = rel.replace(/\\/g, "/");
        let frag = fragment ?? "";
        if (frag) {
          if (/^#[Pp]age_\d+/.test(frag)) {
            frag = "";
          } else if (!frag.startsWith("#^")) {
            frag = `#^${frag.slice(1)}`;
          }
        }
        return `](${rel}${frag})`;
      }
      return `](${stem}.xhtml${fragment ?? ""})`;
    }
  );

  // Fix Obsidian wikilink conflict: [[text](link)] → \[[text](link)\]
  markdown = markdown.replace(
    /\[\[([^\]\[]+)\]\(([^)]+)\)\]/g,
    "\\[[$1]($2)\\]"
  );

  return markdown;
}

async function resolveImages(
  htmlContent: string,
  htmlPath: string,
  fileMap: Map<string, Buffer>,
  imagesDir: string,
  mdImagesPrefix: string
): Promise<string> {
  const dom = new JSDOM(htmlContent);
  const doc = dom.window.document;
  const htmlDir = posixPath.dirname(htmlPath);
  let changed = false;

  for (const img of Array.from(doc.querySelectorAll("img[src]"))) {
    const src = img.getAttribute("src") ?? "";
    if (!src || src.startsWith("data:") || src.startsWith("http")) continue;
    const resolved = posixPath.normalize(posixPath.join(htmlDir, src));
    const imgBuf = fileMap.get(resolved);
    if (!imgBuf) continue;
    const imgFilename = path.basename(resolved);
    const destPath = path.join(imagesDir, imgFilename);
    if (!fs.existsSync(destPath)) {
      fs.writeFileSync(destPath, imgBuf);
    }
    img.setAttribute("src", `${mdImagesPrefix}/${imgFilename}`);
    changed = true;
  }

  return changed ? dom.serialize() : htmlContent;
}

function htmlToMarkdown(htmlContent: string): string {
  const dom = new JSDOM(htmlContent);
  const doc = dom.window.document;
  doc.querySelectorAll("script, style").forEach((el) => el.remove());
  const body = doc.querySelector("body");
  return new CustomTurnDown().convert_soup(body ?? doc.documentElement);
}

function detectZhVariant(
  fileMap: Map<string, Buffer>,
  opfDom: Document
): string {
  function zhSubtag(langAttr: string): string | null {
    const code = (langAttr ?? "").trim().toLowerCase();
    if (!code.startsWith("zh") || code === "zh") return null;
    return normalizeLangCode(langAttr);
  }

  // 1. xml:lang on <package> element
  const pkgs = opfDom.getElementsByTagName("package");
  if (pkgs && pkgs.length > 0) {
    const pkg = pkgs.item ? pkgs.item(0) : pkgs[0];
    const xmlLang = (pkg as any)?.getAttribute?.("xml:lang") ?? "";
    const variant = zhSubtag(xmlLang);
    if (variant) return variant;
  }

  // 2. xml:lang / lang on <html> elements in first few files
  const htmlFiles = Array.from(fileMap.keys())
    .filter((p) => /\.(html|xhtml|htm)$/i.test(p))
    .slice(0, 5);
  for (const filePath of htmlFiles) {
    try {
      const content = fileMap.get(filePath)?.toString("utf-8") ?? "";
      const m = /<html[^>]+(?:xml:lang|lang)=["'](zh[^"']+)["']/i.exec(content.slice(0, 500));
      if (m) {
        const variant = zhSubtag(m[1]);
        if (variant) return variant;
      }
    } catch {
      continue;
    }
  }

  // 3. Character frequency fallback
  const TRAD = new Set("學體為國個書說錄這時長們來東問與發開動現關聯電還");
  const SIMP = new Set("学体为国个书说录这时长们来东问与发开动现关联电还");
  let tradCount = 0;
  let simpCount = 0;
  let sampleChars = 0;
  const sampleFiles = Array.from(fileMap.keys())
    .filter((p) => /\.(html|xhtml|htm)$/i.test(p))
    .slice(0, 10);
  for (const filePath of sampleFiles) {
    const text = fileMap.get(filePath)?.toString("utf-8") ?? "";
    for (const ch of text) {
      if (TRAD.has(ch)) tradCount++;
      else if (SIMP.has(ch)) simpCount++;
    }
    sampleChars += text.length;
    if (sampleChars >= 50000) break;
  }
  return tradCount > simpCount ? "zh-Hant" : "zh-Hans";
}

// ---------------------------------------------------------------------------
// EpubConverter class
// ---------------------------------------------------------------------------

export class EpubConverter implements DocumentConverter {
  async convert(source: string | Buffer, options: ConverterOptions): Promise<ConverterResult> {
    const extension = (options.file_extension ?? "").toLowerCase();
    if (extension !== ".epub") return null;

    let buffer: Buffer;
    if (typeof source === "string") {
      if (!fs.existsSync(source)) throw new Error(`File not found: ${source}`);
      buffer = fs.readFileSync(source);
    } else {
      buffer = source;
    }

    return await this._convertBuffer(buffer, options);
  }

  private async _convertBuffer(buffer: Buffer, options: ConverterOptions): Promise<ConverterResult> {
    // Open ZIP (random-access via unzipper)
    const directory = await unzipper.Open.buffer(buffer);

    // Build file map for random access: path -> buffer
    const fileMap = new Map<string, Buffer>();
    for (const file of directory.files) {
      if (file.type === "File") {
        fileMap.set(file.path, await file.buffer());
      }
    }

    // --- Parse container.xml → locate OPF ---
    const containerBuf = fileMap.get("META-INF/container.xml");
    if (!containerBuf) throw new Error("Invalid EPUB: missing META-INF/container.xml");

    const xmlParser = new DOMParser();
    const containerDom = xmlParser.parseFromString(containerBuf.toString("utf-8"), "text/xml");
    const rootfiles = containerDom.getElementsByTagName("rootfile");
    if (!rootfiles || rootfiles.length === 0) throw new Error("Invalid EPUB: no rootfile in container.xml");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rootfile = (rootfiles.item ? rootfiles.item(0) : rootfiles[0]) as any;
    const opfPath = rootfile.getAttribute("full-path") ?? "";
    if (!opfPath) throw new Error("Invalid EPUB: rootfile has no full-path");

    // --- Parse OPF ---
    const opfBuf = fileMap.get(opfPath);
    if (!opfBuf) throw new Error(`Invalid EPUB: OPF not found at ${opfPath}`);
    const opfDom = xmlParser.parseFromString(opfBuf.toString("utf-8"), "text/xml") as unknown as Document;

    const metadata = {
      title: getTextFromXmlNode(opfDom, "dc:title"),
      authors: getAllTextsFromXmlNodes(opfDom, "dc:creator"),
      language: getTextFromXmlNode(opfDom, "dc:language"),
      publisher: getTextFromXmlNode(opfDom, "dc:publisher"),
      date: getTextFromXmlNode(opfDom, "dc:date"),
      description: getTextFromXmlNode(opfDom, "dc:description"),
      identifier: getTextFromXmlNode(opfDom, "dc:identifier")
    };

    // Build manifest: id → href
    const manifest = new Map<string, string>();
    const manifestItems = opfDom.getElementsByTagName("item");
    for (let i = 0; i < (manifestItems?.length ?? 0); i++) {
      const item = (manifestItems.item ? manifestItems.item(i) : manifestItems[i]) as Element;
      const id = item.getAttribute("id") ?? "";
      const href = item.getAttribute("href") ?? "";
      if (id && href) manifest.set(id, href);
    }

    // Build spine order
    const spineItems = opfDom.getElementsByTagName("itemref");
    const spineOrder: string[] = [];
    for (let i = 0; i < (spineItems?.length ?? 0); i++) {
      const item = (spineItems.item ? spineItems.item(i) : spineItems[i]) as Element;
      const idref = item.getAttribute("idref") ?? "";
      if (idref) spineOrder.push(idref);
    }

    // Resolve spine paths (relative to OPF dir)
    const opfDir = opfPath.includes("/") ? opfPath.split("/").slice(0, -1).join("/") : "";
    const spine: string[] = [];
    for (const itemId of spineOrder) {
      const href = manifest.get(itemId);
      if (href) {
        const fullPath = opfDir ? `${opfDir}/${href}` : href;
        spine.push(fullPath);
      }
    }

    // Reverse map: file path → manifest ID
    const fileToId = new Map<string, string>();
    for (const [id, href] of manifest) {
      const fullPath = opfDir ? `${opfDir}/${href}` : href;
      fileToId.set(fullPath, id);
    }

    // --- Language detection ---
    const langOverride = options.language;
    let langCode = langOverride ?? metadata.language ?? "en";
    if (langCode.toLowerCase() === "zh" && !langOverride) {
      langCode = detectZhVariant(fileMap, opfDom as unknown as Document);
    }
    const langConfig = loadLangConfig(langCode);

    // --- Options ---
    const splitByChapter = options.split_by_chapter ?? false;
    const organize = splitByChapter && !(options.no_organize ?? false);
    const chaptersOutputDir = options.chapters_output_dir;
    const saveImages = options.save_images ?? false;

    // Set up images directory
    let actualImagesDir: string | undefined;
    if (saveImages && organize && chaptersOutputDir) {
      actualImagesDir = path.join(chaptersOutputDir, "assets");
      fs.mkdirSync(actualImagesDir, { recursive: true });
    } else if (saveImages && chaptersOutputDir) {
      actualImagesDir = path.join(chaptersOutputDir, "assets");
      fs.mkdirSync(actualImagesDir, { recursive: true });
    } else if (saveImages && typeof saveImages === "string") {
      actualImagesDir = saveImages;
      fs.mkdirSync(actualImagesDir, { recursive: true });
    }

    const markdownContent: string[] = [];
    const chapterFilenames: string[] = [];
    const chapterCounter: ChapterCounter = { max: 0, seen: {} };
    let navTocLines: string[] = [];
    let inBackMatterZone = false;
    let firstChapterSeen = false;
    const bookTitle = (metadata.title ?? "").trim();
    const usedPaths: Record<string, number> = {};

    // --- Pass 1 (organize mode only): build stem → outpath map ---
    const cachedHtml = new Map<string, string>();
    const stemToOutpath: Record<string, string> = {};

    if (organize) {
      const preCounter: ChapterCounter = { max: 0, seen: {} };
      for (const file of spine) {
        if (!fileMap.has(file)) continue;
        const fileStem = path.basename(file).replace(/\.[^.]+$/, "");
        const itemId = fileToId.get(file) ?? fileStem;
        const stemHint = itemId;
        const htmlContent = fileMap.get(file)!.toString("utf-8");
        cachedHtml.set(file, htmlContent);

        if (isNoiseItem(stemHint, fileStem)) continue;

        const epubType = getEpubType(htmlContent);
        const title = getChapterTitle(htmlContent);

        const skipTitles = langConfig.skip_titles ?? [];
        if (title && skipTitles.some((kw) => title.includes(kw))) continue;
        const skipPats = langConfig.skip_title_patterns ?? [];
        if (title && skipPats.some((p) => new RegExp(p).test(title))) continue;

        const subdir = epubTypeToSubdir(epubType, stemHint, title, langConfig);
        const outFn = mapToOutputFilename(title, stemHint, subdir, preCounter, langConfig);
        const outPathPre = subdir ? `${subdir}/${outFn}` : outFn;

        stemToOutpath[fileStem] = outPathPre;
        if (itemId !== fileStem) stemToOutpath[itemId] = outPathPre;
      }
    }

    // --- Main pass: convert each spine item ---
    for (const file of spine) {
      if (!fileMap.has(file)) continue;

      let htmlContent = cachedHtml.get(file) ?? fileMap.get(file)!.toString("utf-8");
      const fileStem = path.basename(file).replace(/\.[^.]+$/, "");
      const itemId = fileToId.get(file) ?? fileStem;
      const stem = itemId;

      let outPath: string;

      if (organize) {
        const epubType = getEpubType(htmlContent);
        const title = getChapterTitle(htmlContent);

        // Skip noise items
        if (isNoiseItem(stem, fileStem)) {
          if (/nav|toc|navigation/i.test(stem)) {
            navTocLines = extractNavLinks(htmlContent);
          }
          continue;
        }

        // Skip by title
        const skipTitles = langConfig.skip_titles ?? [];
        if (title && skipTitles.some((kw) => title.includes(kw))) continue;
        const skipPats = langConfig.skip_title_patterns ?? [];
        if (title && skipPats.some((p) => new RegExp(p).test(title))) continue;

        let subdir = epubTypeToSubdir(epubType, stem, title, langConfig);

        // Sticky back-matter logic
        if (subdir === "back-matter") {
          inBackMatterZone = true;
        } else if (subdir === "chapters" && inBackMatterZone) {
          const hasChapterMatch = (langConfig.chapter_patterns ?? []).some((pat) => {
            const flags = normalizePythonFlags(pat.flags ?? []);
            return new RegExp(pat.regex, flags).test(title ?? "");
          });
          if (!hasChapterMatch) subdir = "back-matter";
        } else if (subdir === "chapters") {
          const hasChapterMatch = (langConfig.chapter_patterns ?? []).some((pat) => {
            const flags = normalizePythonFlags(pat.flags ?? []);
            return new RegExp(pat.regex, flags).test(title ?? "");
          });
          if (hasChapterMatch) {
            firstChapterSeen = true;
          } else if (!firstChapterSeen && (title ?? "").length <= 3) {
            subdir = "front-matter";
          } else if (
            bookTitle &&
            title &&
            title.length > 3 &&
            (title === bookTitle ||
              (title.length >= bookTitle.length * 0.85 && bookTitle.startsWith(title)))
          ) {
            subdir = "back-matter";
            inBackMatterZone = true;
          }
        }

        // Resolve images
        if (actualImagesDir && chaptersOutputDir) {
          const fileDir = subdir ? path.join(chaptersOutputDir, subdir) : chaptersOutputDir;
          const mdImagesPrefix = path.relative(path.resolve(fileDir), path.resolve(actualImagesDir)).replace(/\\/g, "/");
          htmlContent = await resolveImages(htmlContent, file, fileMap, actualImagesDir, mdImagesPrefix);
        }

        // Inject Obsidian block refs
        htmlContent = injectBlockRefs(htmlContent);

        // Generate output filename
        const outFn = mapToOutputFilename(title, stem, subdir, chapterCounter, langConfig);
        outPath = subdir ? `${subdir}/${outFn}` : outFn;

        // Deduplicate
        const baseOutPath = outPath;
        const collisionN = usedPaths[baseOutPath] ?? 0;
        if (collisionN > 0) {
          const dotIdx = baseOutPath.lastIndexOf(".");
          const ext = dotIdx >= 0 ? baseOutPath.slice(dotIdx) : "";
          const base = dotIdx >= 0 ? baseOutPath.slice(0, dotIdx) : baseOutPath;
          outPath = `${base}-${collisionN + 1}${ext}`;
        }
        usedPaths[baseOutPath] = collisionN + 1;
      } else {
        // Non-organized mode
        if (actualImagesDir) {
          const mdImagesPrefix = "./assets";
          htmlContent = await resolveImages(htmlContent, file, fileMap, actualImagesDir, mdImagesPrefix);
        }
        outPath = `${fileStem}.md`;
      }

      // Convert HTML → Markdown
      const md = htmlToMarkdown(htmlContent).trim();
      const finalMd = organize && Object.keys(stemToOutpath).length > 0
        ? rewriteEpubLinks(md, stemToOutpath, outPath)
        : md;

      markdownContent.push(finalMd);
      chapterFilenames.push(outPath);
    }

    // --- Build metadata block ---
    const metadataLines: string[] = [];
    if (metadata.title) metadataLines.push(`**Title:** ${metadata.title}`);
    if (metadata.authors.length > 0) metadataLines.push(`**Authors:** ${metadata.authors.join(", ")}`);
    if (metadata.language) metadataLines.push(`**Language:** ${metadata.language}`);
    if (metadata.publisher) metadataLines.push(`**Publisher:** ${metadata.publisher}`);
    if (metadata.date) metadataLines.push(`**Date:** ${metadata.date}`);
    const metadataStr = metadataLines.join("\n");

    if (organize) {
      const readmeLines = [`# ${metadata.title ?? "Book"}`, "", metadataStr];
      if (navTocLines.length > 0) {
        readmeLines.push("", "## Table of Contents", "", ...navTocLines);
      }
      const readmeContent = readmeLines.join("\n");
      markdownContent.unshift(readmeContent);
      chapterFilenames.unshift("README.md");
    } else {
      markdownContent.unshift(metadataStr);
      chapterFilenames.unshift("metadata.md");
    }

    // --- Write files to disk if output dir specified ---
    if (splitByChapter && chaptersOutputDir) {
      for (let i = 0; i < chapterFilenames.length; i++) {
        const fname = chapterFilenames[i];
        const fpath = path.join(chaptersOutputDir, fname);
        fs.mkdirSync(path.dirname(fpath), { recursive: true });
        fs.writeFileSync(fpath, markdownContent[i], "utf-8");
      }
    }

    const chapters =
      splitByChapter ? chapterFilenames.map((fn, i) => [fn, markdownContent[i]] as [string, string]) : undefined;

    const chapterSep = splitByChapter ? "\n\n---\n\n" : "\n\n";
    const fullMarkdown = markdownContent.join(chapterSep);

    return {
      title: metadata.title,
      markdown: fullMarkdown,
      text_content: fullMarkdown,
      chapters
    };
  }
}
