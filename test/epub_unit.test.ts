import { describe, it, expect } from 'vitest';
import {
  normalizeLangCode,
  loadLangConfig,
  normalizePythonFlags,
  getChapterTitle,
  mapToOutputFilename,
  isNoiseItem,
} from '../src/converters/epub';

// ---------------------------------------------------------------------------
// normalizeLangCode
// ---------------------------------------------------------------------------
describe('normalizeLangCode', () => {
  it('returns base code for simple languages', () => {
    expect(normalizeLangCode('en')).toBe('en');
    expect(normalizeLangCode('de')).toBe('de');
    expect(normalizeLangCode('ja')).toBe('ja');
    expect(normalizeLangCode('ko')).toBe('ko');
    expect(normalizeLangCode('ru')).toBe('ru');
    expect(normalizeLangCode('it')).toBe('it');
  });

  it('strips region subtag for non-zh', () => {
    expect(normalizeLangCode('en-US')).toBe('en');
    expect(normalizeLangCode('de-DE')).toBe('de');
    expect(normalizeLangCode('fr-FR')).toBe('fr');
  });

  it('maps zh variants to zh-Hans', () => {
    expect(normalizeLangCode('zh')).toBe('zh-Hans');
    expect(normalizeLangCode('zh-CN')).toBe('zh-Hans');
    expect(normalizeLangCode('ZH')).toBe('zh-Hans');
    expect(normalizeLangCode('zh_CN')).toBe('zh-Hans');
  });

  it('maps zh-Hant variants', () => {
    expect(normalizeLangCode('zh-TW')).toBe('zh-Hant');
    expect(normalizeLangCode('zh-HK')).toBe('zh-Hant');
    expect(normalizeLangCode('zh-MO')).toBe('zh-Hant');
    expect(normalizeLangCode('zh-Hant')).toBe('zh-Hant');
  });

  it('trims whitespace', () => {
    expect(normalizeLangCode(' en ')).toBe('en');
  });
});

// ---------------------------------------------------------------------------
// loadLangConfig
// ---------------------------------------------------------------------------
describe('loadLangConfig', () => {
  it('loads en config with chapter_patterns', () => {
    const cfg = loadLangConfig('en');
    expect(cfg.chapter_patterns?.length).toBeGreaterThan(0);
  });

  it('loads zh-Hans config with chapter_filename_use_title', () => {
    const cfg = loadLangConfig('zh-Hans');
    expect(cfg.chapter_filename_use_title).toBe(true);
  });

  it('loads zh-Hant config with chapter_filename_use_title', () => {
    const cfg = loadLangConfig('zh-Hant');
    expect(cfg.chapter_filename_use_title).toBe(true);
  });

  it('loads ja config with chapter_patterns', () => {
    const cfg = loadLangConfig('ja');
    expect(cfg.chapter_patterns?.length).toBeGreaterThan(0);
  });

  it('loads all 11 language configs', () => {
    for (const lang of ['en','de','fr','it','es','pt','ru','ja','ko','zh-Hans','zh-Hant']) {
      const cfg = loadLangConfig(lang);
      expect(cfg, `missing config for ${lang}`).toBeDefined();
      expect(cfg.chapter_patterns, `no chapter_patterns for ${lang}`).toBeDefined();
    }
  });

  it('returns default config (english fallback) for unknown language', () => {
    const cfg = loadLangConfig('xx-unknown');
    // Falls back to English-style default with 1 chapter pattern
    expect((cfg.chapter_patterns?.length ?? 0)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// normalizePythonFlags
// ---------------------------------------------------------------------------
describe('normalizePythonFlags', () => {
  it('maps IGNORECASE to i', () => expect(normalizePythonFlags(['IGNORECASE'])).toBe('i'));
  it('maps MULTILINE to m', () => expect(normalizePythonFlags(['MULTILINE'])).toBe('m'));
  it('maps DOTALL to s', () => expect(normalizePythonFlags(['DOTALL'])).toBe('s'));
  it('maps UNICODE to u', () => expect(normalizePythonFlags(['UNICODE'])).toBe('u'));
  it('filters VERBOSE', () => expect(normalizePythonFlags(['VERBOSE'])).toBe(''));
  it('combines flags', () => expect(normalizePythonFlags(['IGNORECASE','MULTILINE'])).toBe('im'));
  it('handles empty', () => expect(normalizePythonFlags([])).toBe(''));
});

// ---------------------------------------------------------------------------
// getChapterTitle
// ---------------------------------------------------------------------------
describe('getChapterTitle', () => {
  it('extracts h1', () => {
    expect(getChapterTitle('<html><body><h1>Chapter One</h1></body></html>')).toBe('Chapter One');
  });
  it('prefers h1 over h2', () => {
    expect(getChapterTitle('<html><body><h1>Main</h1><h2>Sub</h2></body></html>')).toBe('Main');
  });
  it('falls back to h2', () => {
    expect(getChapterTitle('<html><body><h2>Chapter 2</h2></body></html>')).toBe('Chapter 2');
  });
  it('falls back to h3', () => {
    expect(getChapterTitle('<html><body><h3>Section</h3></body></html>')).toBe('Section');
  });
  it('uses p.title as fallback', () => {
    expect(getChapterTitle('<html><body><p class="title">Book Title</p></body></html>')).toBe('Book Title');
  });
  it('falls back to head title', () => {
    expect(getChapterTitle('<html><head><title>Page Title</title></head><body><p>text</p></body></html>')).toBe('Page Title');
  });
  it('returns empty for bare body', () => {
    expect(getChapterTitle('<html><body></body></html>')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// isNoiseItem
// ---------------------------------------------------------------------------
describe('isNoiseItem', () => {
  it('returns true for nav/toc stems', () => {
    expect(isNoiseItem('toc', 'toc')).toBe(true);
    expect(isNoiseItem('nav', 'nav')).toBe(true);
    expect(isNoiseItem('navigation', 'navigation')).toBe(true);
    expect(isNoiseItem('eula', 'eula')).toBe(true);
  });
  it('returns false for chapter stems', () => {
    expect(isNoiseItem('chapter01', 'chapter01')).toBe(false);
    expect(isNoiseItem('cover', 'cover')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mapToOutputFilename
// ---------------------------------------------------------------------------
describe('mapToOutputFilename', () => {
  const freshCounter = () => ({ seen: {} as Record<number, number>, max: 0 });

  describe('chapters – EN', () => {
    const cfg = loadLangConfig('en');
    it('Chapter 1 -> 01-*.md', () => {
      expect(mapToOutputFilename('Chapter 1 Introduction', 'ch01', 'chapters', freshCounter(), cfg)).toMatch(/^01-.*\.md$/);
    });
    it('Chapter 10 -> 10-*.md', () => {
      expect(mapToOutputFilename('Chapter 10 The End', 'ch10', 'chapters', freshCounter(), cfg)).toMatch(/^10-/);
    });
    it('auto-increment sequential', () => {
      const c = freshCounter();
      const fn1 = mapToOutputFilename('Some Title', 'f1', 'chapters', c, cfg);
      const fn2 = mapToOutputFilename('Other Title', 'f2', 'chapters', c, cfg);
      expect(parseInt(fn2)).toBeGreaterThan(parseInt(fn1));
    });
    it('duplicate chapter num gets b suffix', () => {
      const c = freshCounter();
      mapToOutputFilename('Chapter 1 First', 'c1', 'chapters', c, cfg);
      expect(mapToOutputFilename('Chapter 1 Dup', 'c1b', 'chapters', c, cfg)).toMatch(/^01b-/);
    });
  });

  describe('chapters – DE', () => {
    const cfg = loadLangConfig('de');
    it('Kapitel 3 -> 03-*.md', () => {
      expect(mapToOutputFilename('Kapitel 3: Der Plan', 'k3', 'chapters', freshCounter(), cfg)).toMatch(/^03-/);
    });
  });

  describe('chapters – FR', () => {
    const cfg = loadLangConfig('fr');
    it('Chapitre 5 -> 05-*.md', () => {
      expect(mapToOutputFilename('Chapitre 5', 'c5', 'chapters', freshCounter(), cfg)).toMatch(/^05-/);
    });
  });

  describe('chapters – ZH-Hans', () => {
    const cfg = loadLangConfig('zh-Hans');
    it('uses CJK title as filename', () => {
      const fn = mapToOutputFilename('第三章 开始', 'ch03', 'chapters', freshCounter(), cfg);
      expect(fn).toMatch(/第三章/);
      expect(fn).not.toMatch(/^03-/);
    });
  });

  describe('chapters – JA', () => {
    const cfg = loadLangConfig('ja');
    it('uses CJK title', () => {
      expect(mapToOutputFilename('第三章 始まり', 'ch03', 'chapters', freshCounter(), cfg)).toMatch(/第三章/);
    });
  });

  describe('chapters – KO', () => {
    const cfg = loadLangConfig('ko');
    it('제3장 -> 03-*.md', () => {
      expect(mapToOutputFilename('제3장', 'ch3', 'chapters', freshCounter(), cfg)).toMatch(/^03-/);
    });
  });

  describe('front/back-matter', () => {
    const cfg = loadLangConfig('en');
    it('uses title stem for short title', () => {
      expect(mapToOutputFilename('Cover', 'cover', 'front-matter', freshCounter(), cfg)).toBe('cover.md');
    });
    it('uses file stem if title too long', () => {
      const fn = mapToOutputFilename('A'.repeat(50), 'section0001', 'front-matter', freshCounter(), cfg);
      expect(fn).toBe('section0001.md');
    });
  });
});
