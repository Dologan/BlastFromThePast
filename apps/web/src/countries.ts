// ISO 3166-1 alpha-2 codes are what the library stores and what recipes
// filter on, but they're not friendly to read — resolve them to display
// names via the browser's built-in locale data (no dependency, no network).
const regionNames =
  typeof Intl !== 'undefined' && 'DisplayNames' in Intl
    ? new Intl.DisplayNames(['en'], { type: 'region' })
    : null;

export function countryName(code: string): string {
  if (!code) return code;
  try {
    return regionNames?.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}
