import { describe, it, expect, afterEach } from "vitest";
import { MarkItDown } from "../src/markitdown";
import { EpubConverter } from "../src/converters/epub";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

const EPUB_DIR = path.join(__dirname, "__files/epub");
const EN_EPUB = path.join(EPUB_DIR, "Mans Search For Meaning (Viktor Emil Frankl) (Z-Library).epub");
const ZH_HANS_EPUB = path.join(EPUB_DIR, "不原谅也没关系 (皮特·沃克) (Z-Library).epub");

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "epub-test-"));
}

describe("EpubConverter", () => {
  const cleanupDirs: string[] = [];

  afterEach(() => {
    for (const dir of cleanupDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    cleanupDirs.length = 0;
  });

  describe("Basic conversion", () => {
    it("should return null for non-epub files", async () => {
      const converter = new EpubConverter();
      const result = await converter.convert(Buffer.from("hello"), { file_extension: ".txt" });
      expect(result).toBeNull();
    });

    it("should convert English EPUB to markdown", async () => {
      const markitdown = new MarkItDown();
      const result = await markitdown.convert(EN_EPUB);
      expect(result).not.toBeNull();
      expect(result?.markdown).toBeTruthy();
      expect(result?.title).toBeTruthy();
      // Should contain book content
      expect(result?.markdown).toContain("Frankl");
    });

    it("should convert zh-Hans EPUB to markdown", async () => {
      const markitdown = new MarkItDown();
      const result = await markitdown.convert(ZH_HANS_EPUB);
      expect(result).not.toBeNull();
      expect(result?.markdown).toBeTruthy();
      expect(result?.title).toBeTruthy();
    });
  });

  describe("split_by_chapter with organize mode (English)", () => {
    it("should split EN EPUB into chapters with organized structure", async () => {
      const outDir = tmpDir();
      cleanupDirs.push(outDir);

      const markitdown = new MarkItDown();
      const result = await markitdown.convert(EN_EPUB, {
        split_by_chapter: true,
        chapters_output_dir: outDir,
        save_images: true,
        language: "en"
      });

      expect(result).not.toBeNull();
      expect(result?.chapters).toBeDefined();
      // Python produces 18 chapters for this book
      expect(result?.chapters!.length).toBeGreaterThanOrEqual(10);

      // README.md should exist
      const readme = path.join(outDir, "README.md");
      expect(fs.existsSync(readme)).toBe(true);
      const readmeContent = fs.readFileSync(readme, "utf-8");
      expect(readmeContent).toContain("Frankl");

      // chapters/ subdirectory should exist (EN epub has numbered chapters)
      const chaptersDir = path.join(outDir, "chapters");
      expect(fs.existsSync(chaptersDir)).toBe(true);
      const chapterFiles = fs.readdirSync(chaptersDir);
      expect(chapterFiles.length).toBeGreaterThan(0);
      // Files should be numbered (01-*, 02-*, etc.)
      const hasNumberedFiles = chapterFiles.some((f) => /^\d{2}/.test(f));
      expect(hasNumberedFiles).toBe(true);
      console.log("EN chapter files:", chapterFiles.slice(0, 10));
    }, 60000);
  });

  describe("split_by_chapter with organize mode (Chinese Simplified)", () => {
    it("should split zh-Hans EPUB chapters (book with no headings → back-matter)", async () => {
      const outDir = tmpDir();
      cleanupDirs.push(outDir);

      const markitdown = new MarkItDown();
      const result = await markitdown.convert(ZH_HANS_EPUB, {
        split_by_chapter: true,
        chapters_output_dir: outDir,
        save_images: true,
        language: "zh-Hans"
      });

      expect(result).not.toBeNull();
      expect(result?.chapters).toBeDefined();
      // Python produces 35 chapters for this book
      expect(result?.chapters!.length).toBeGreaterThanOrEqual(20);

      // README.md should exist
      const readme = path.join(outDir, "README.md");
      expect(fs.existsSync(readme)).toBe(true);

      const allChapterPaths = result?.chapters!.map(([fn]) => fn) ?? [];
      console.log("zh-Hans chapters (first 10):", allChapterPaths.slice(0, 10));

      // This epub has no headings - all content gets classified as front-matter or back-matter
      // because all files have the book title as their <head><title> 
      const hasBackMatter = allChapterPaths.some((p) => p.startsWith("back-matter/"));
      expect(hasBackMatter).toBe(true);
    }, 60000);
  });

  describe("save_images option", () => {
    it("should save images to assets directory when save_images is true", async () => {
      const outDir = tmpDir();
      cleanupDirs.push(outDir);

      const markitdown = new MarkItDown();
      const result = await markitdown.convert(EN_EPUB, {
        split_by_chapter: true,
        chapters_output_dir: outDir,
        save_images: true
      });

      expect(result).not.toBeNull();
      expect(result?.chapters).toBeDefined();
      expect(result?.chapters!.length).toBeGreaterThan(0);
      // assets/ dir should be created
      const assetsDir = path.join(outDir, "assets");
      expect(fs.existsSync(assetsDir)).toBe(true);
    }, 60000);
  });

  describe("Language detection", () => {
    it("should auto-detect language from epub metadata", async () => {
      const outDir = tmpDir();
      cleanupDirs.push(outDir);

      const markitdown = new MarkItDown();
      const result = await markitdown.convert(EN_EPUB, {
        split_by_chapter: true,
        chapters_output_dir: outDir
      });

      expect(result).not.toBeNull();
      expect(result?.chapters!.length).toBeGreaterThan(0);
      // chapters/ should exist for EN epub
      const chaptersDir = path.join(outDir, "chapters");
      expect(fs.existsSync(chaptersDir)).toBe(true);
    }, 60000);
  });
});
