// Check every visual direction, not just the last CSS override.
// This prevents an attractive-but-illegible category theme from shipping.
import { readFileSync } from 'node:fs';
const css = readFileSync(new URL('../src/styles/theme.css', import.meta.url), 'utf8');
const styles = ['atelier', 'industrial', 'editorial'];
const tokens = (block) => {
  const result = {};
  for (const [, key, light, dark] of block.matchAll(/(--[a-z][\w-]*):\s*light-dark\(\s*(#[0-9a-f]{6})\s*,\s*(#[0-9a-f]{6})\s*\)/gi)) result[key] = [light, dark];
  for (const [, key, hex] of block.matchAll(/(--[a-z][\w-]*):\s*(#[0-9a-f]{6})\s*;/gi)) result[key] = [hex, hex];
  return result;
};
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [high, low] = [lum(a), lum(b)].sort((a, b) => b - a);
  return (high + 0.05) / (low + 0.05);
};
let failed = false;
for (const style of styles) {
  const block = css.match(new RegExp("html\\[data-editorial-style='" + style + "'\\]\\s*\\{([^}]*)\\}"));
  if (!block) throw Error('Missing visual profile: ' + style);
  const palette = tokens(block[1]);
  const pairs = [
    ...['--foreground', '--muted', '--primary'].flatMap((text) => ['--background', '--surface'].map((bg) => [text, bg])),
    ['--on-primary', '--primary'],
    ...['--on-plate', '--on-plate-muted', '--primary-on-plate'].map((text) => [text, '--plate']),
  ];
  for (const mode of [0, 1]) {
    for (const [fg, bg] of pairs) {
      if (!palette[fg] || !palette[bg]) throw Error(style + ': missing ' + (!palette[fg] ? fg : bg));
      const value = contrast(palette[fg][mode], palette[bg][mode]);
      if (value < 4.5) {
        console.error(style + ' ' + (mode ? 'dark' : 'light') + ': ' + fg + ' vs ' + bg + ': ' + value.toFixed(2) + ' FAIL');
        failed = true;
      }
    }
  }
  if (!failed) console.log(style + ': contrast pairs PASS');
}
if (failed) process.exitCode = 1;
