const SPECIAL = /[.+^${}()|[\]\\]/g;

export function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          // `**/` spans zero or more whole path segments.
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(SPECIAL, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

export function matchGlob(filePath: string, pattern: string): boolean {
  return globToRegExp(pattern).test(filePath);
}
