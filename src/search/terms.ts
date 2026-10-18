const stopWords = new Set(
  'a an and are about before can chat chats compare compared comparison too conversation conversations did discuss discussed do find for from had has have help how i in is it looking looked me my of on or options our previously search searched searching session sessions that the this thread threads to was we talk talked talking were what when where which with your'.split(
    ' ',
  ),
);

// Grammatical search phrasing only. No topic/category/synonym vocabulary.
export function isContentWord(word: string): boolean {
  return !stopWords.has(word);
}

export function descriptionWords(text: string): string[] {
  return (
    text
      .replace(/^show(?:\s+me)?\b/iu, '')
      .replace(/\blast month\b/giu, '')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).filter(isContentWord);
}
