/** Give short, unbroken values in data cells enough room to remain legible.
 * Keep long tokens breakable and leave nested tables and empty spacer cells alone. */
export function markReadableTableCells(root: Element) {
  for (const cell of root.querySelectorAll('td, th')) {
    if (cell.querySelector('table, a, .orca-mail-image-note')) continue;
    const value = cell.textContent?.trim() ?? '';
    if (/^\S{8,40}$/u.test(value)) cell.classList.add('reader-short-cell-value');
  }
}

/** Keep flow content in one-column tables within the reading measure without
 * flattening or relabeling any table. Multi-column/data tables keep their
 * semantics and intrinsic widths in their own keyboard-scrollable region. */
export function containReaderTables(root: Element) {
  for (const code of root.querySelectorAll<HTMLElement>('pre')) {
    code.tabIndex = 0;
    code.setAttribute('role', 'region');
    code.setAttribute('aria-label', 'Code block');
    code.setAttribute('aria-description', 'Scroll horizontally to read long lines.');
  }
  for (const table of root.querySelectorAll<HTMLTableElement>('table')) {
    const rows = [...table.rows];
    const singleColumn = rows.length > 0 && rows.every(row => row.cells.length === 1 && row.cells[0]!.colSpan === 1);
    if (singleColumn) table.classList.add('reader-flow-table');
    if (table.classList.contains('orca-mail-layout') || singleColumn || table.parentElement?.classList.contains('reader-table-scroll')) continue;
    const scroll = document.createElement('div');
    scroll.className = 'reader-table-scroll';
    scroll.tabIndex = 0;
    scroll.setAttribute('role', 'region');
    scroll.setAttribute('aria-label', 'Message table');
    scroll.setAttribute('aria-description', 'Scroll horizontally to read every column.');
    table.before(scroll); scroll.append(table);
  }
}
