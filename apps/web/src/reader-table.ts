/** Give short, unbroken values in data cells enough room to remain legible.
 * Keep long tokens breakable and leave nested tables and empty spacer cells alone. */
export function markReadableTableCells(root: Element) {
  for (const cell of root.querySelectorAll('td, th')) {
    if (cell.querySelector('table, a, .orca-mail-image-note')) continue;
    const value = cell.textContent?.trim() ?? '';
    if (/^\S{8,40}$/u.test(value)) cell.classList.add('reader-short-cell-value');
  }
}
