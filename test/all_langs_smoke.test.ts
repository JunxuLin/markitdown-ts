
import { describe, it, expect, afterAll } from 'vitest';
import { MarkItDown } from '../src/markitdown';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const EPUB_DIR = path.join(__dirname, '__files/epub');
const OUT_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'epub-all-'));

const EPUBS = [
  { file: 'Mans Search For Meaning (Viktor Emil Frankl) (Z-Library).epub', lang: 'en', label: 'English' },
  { file: 'Irische Leidenschaft.epub', lang: 'de', label: 'German' },
  { file: "Un château en Bohême.epub", lang: 'fr', label: 'French' },
  { file: 'La Divina Commedia.epub', lang: 'it', label: 'Italian' },
  { file: 'Don Quijote.epub', lang: 'es', label: 'Spanish' },
  { file: 'Os Maias.epub', lang: 'pt', label: 'Portuguese' },
  { file: 'Тестовый роман.epub', lang: 'ru', label: 'Russian' },
  { file: 'テスト小説_桜の下で.epub', lang: 'ja', label: 'Japanese' },
  { file: '외국인을 위한 한국어 읽기 23 인물 이야기 - 바보 온달과 평강 공주, 신라 장군 김유신과 고구려의 점쟁이 추남, 낙랑 공주와 호동 왕자.epub', lang: 'ko', label: 'Korean' },
  { file: '«외국인을 위한 한국어 읽기»: 18. 견우와 직녀의 눈물·우렁이색시·설씨와 가실의 사랑.epub', lang: 'ko', label: 'Korean2' },
  { file: '不原谅也没关系 (皮特·沃克) (Z-Library).epub', lang: 'zh-Hans', label: 'zh-Hans' },
  { file: '不可打擾（《上癮》作者新作，簡單到不可能失敗的注意力管理法則，告別自我損耗，破除消極衝動，掌控生活） (尼爾·埃亞爾) (Z-Library).epub', lang: undefined, label: 'zh-Hant (auto)' },
  { file: 'Romanzo italiano.epub', lang: 'it', label: 'Italian2' },
];

afterAll(() => {
  fs.rmSync(OUT_BASE, { recursive: true, force: true });
});

describe('All Language EPUBs', () => {
  for (const { file, lang, label } of EPUBS) {
    it(`[${label}] ${file.slice(0, 40)}`, async () => {
      const epubPath = path.join(EPUB_DIR, file);
      expect(fs.existsSync(epubPath), `epub file missing: ${file}`).toBe(true);

      const outDir = path.join(OUT_BASE, label.replace(/[^a-zA-Z0-9]/g, '_'));
      const markitdown = new MarkItDown();

      let result: any;
      try {
        result = await markitdown.convert(epubPath, {
          split_by_chapter: true,
          chapters_output_dir: outDir,
          save_images: true,
          ...(lang ? { language: lang } : {})
        });
      } catch (e: any) {
        console.error(`[${label}] ERROR:`, e.message);
        throw e;
      }

      expect(result).not.toBeNull();
      expect(result?.chapters?.length).toBeGreaterThan(0);

      const readme = path.join(outDir, 'README.md');
      expect(fs.existsSync(readme), 'README.md missing').toBe(true);

      const subdirs = fs.readdirSync(outDir).filter(f => 
        fs.statSync(path.join(outDir, f)).isDirectory()
      );
      console.log(`[${label}] chapters: ${result?.chapters?.length}, dirs: ${subdirs.join(', ')}`);
      
      const allChapters = result?.chapters?.map(([fn]: [string,string]) => fn) ?? [];
      console.log(`  First 5:`, allChapters.slice(1, 6));
    }, 60000);
  }
});
