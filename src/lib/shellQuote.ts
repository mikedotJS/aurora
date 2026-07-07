// Quote a string so the shell treats it as a single word.
//
// Only quotes when needed: a value made purely of characters the shell never
// treats specially (alnum and common path punctuation) is returned unchanged,
// so ordinary folder names stay plain and re-completion keeps working. Anything
// else — most importantly a path/name containing a space — is wrapped in single
// quotes, with any embedded single quote escaped as '\'' . Single-quote form is
// safe because the shell does no expansion inside it.
//
// Used wherever a stored path or a completed folder name is turned into a
// command line (cd-frecency accept, folder-completion accept) so a directory
// like "Google Drive" doesn't word-split and silently break the jump.
export function shQuote(s: string): string {
  if (s !== "" && /^[A-Za-z0-9_./:@%+,=-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
