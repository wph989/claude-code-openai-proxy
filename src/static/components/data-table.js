export function renderTableHead(fields, sortState, labels) {
  let html = '<thead><tr>';
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    const sorted = sortState.field === field ? ' sorted' : '';
    const arrow = sortState.field === field ? (sortState.asc ? ' ▲' : ' ▼') : ' ⇅';
    html += `<th data-field="${field}" class="${sorted}">${labels[index]}<span class="sort-arrow">${arrow}</span></th>`;
  }
  return `${html}<th class="col-actions">操作</th></tr></thead>`;
}

export function renderPagination(page, total, totalItems) {
  if (total <= 1) return '';
  return `<div class="pagination">
    <span class="pagination-info">共 ${totalItems} 条，第 ${page}/${total} 页</span>
    <div class="pagination-btns">
      <button class="btn btn-small" id="prevPage" ${page <= 1 ? 'disabled' : ''}>上一页</button>
      <span class="page-num">${page} / ${total}</span>
      <button class="btn btn-small" id="nextPage" ${page >= total ? 'disabled' : ''}>下一页</button>
    </div>
  </div>`;
}
