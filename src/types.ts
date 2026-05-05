import { LanguageModel } from "ai";
import mammoth from "mammoth";

export type ConverterResult =
  | {
      title: string | null;
      markdown: string;
      /** @deprecated Use `markdown` instead. */
      text_content: string;
      /** EPUB chapter output: array of [filename, markdown] tuples */
      chapters?: [string, string][];
    }
  | null
  | undefined;

export type ConverterOptions = {
  llmModel?: LanguageModel;
  llmPrompt?: string;
  file_extension?: string;
  url?: string;
  fetch?: typeof fetch;
  enableYoutubeTranscript?: boolean;
  youtubeTranscriptLanguage?: string;
  cleanupExtracted?: boolean;
  //
  _parent_converters?: DocumentConverter[];
  // EPUB-specific options
  split_by_chapter?: boolean;
  chapters_output_dir?: string;
  save_images?: boolean | string;
  no_organize?: boolean;
  language?: string;
} & MammothOptions;

type MammothOptions = Parameters<typeof mammoth.convertToHtml>[1];

export interface DocumentConverter {
  convert(source: string | Buffer, options: ConverterOptions): Promise<ConverterResult>;
}
