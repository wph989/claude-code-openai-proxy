/** 管理页通用 UI 组件与安全 DOM 工具。 */

export function escapeHtml(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function replaceSelectOptions(select, options, selectedValue, emptyLabel = null) {
  // 配置值必须通过 textContent 写入，不能拼 innerHTML，否则模型名可逃逸 option 形成存储型 XSS。
  select.replaceChildren();
  if (emptyLabel != null) {
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = emptyLabel;
    select.appendChild(empty);
  }
  for (const option of options) {
    const element = document.createElement('option');
    element.value = option.value;
    element.textContent = option.label;
    select.appendChild(element);
  }
  select.value = options.some((option) => option.value === selectedValue) ? selectedValue : '';
}

export const Dialog = {
  overlay: null,
  container: null,
  keydownHandler: null,
  previousFocus: null,
  closeHandler: null,

  init() {
    if (this.overlay) return;
    this.overlay = document.createElement('div');
    this.overlay.className = 'dialog-overlay';
    this.overlay.innerHTML = `
      <div class="dialog-container" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <div class="dialog-header">
          <span class="dialog-title" id="dialog-title"></span>
          <button class="dialog-close" aria-label="关闭">×</button>
        </div>
        <div class="dialog-content"></div>
        <div class="dialog-footer"></div>
      </div>
    `;
    document.body.appendChild(this.overlay);
    this.container = this.overlay.querySelector('.dialog-container');
    this.overlay.addEventListener('click', (event) => {
      if (event.target === this.overlay) this.hide();
    });
    this.overlay.querySelector('.dialog-close').addEventListener('click', () => this.hide());
  },

  show(title, content, buttons = [], options = {}) {
    this.init();
    this.previousFocus = document.activeElement;
    this.closeHandler = typeof options.onClose === 'function' ? options.onClose : null;
    this.container.classList.toggle('dialog-large', options.size === 'large');
    this.overlay.querySelector('.dialog-title').textContent = title;
    this.overlay.querySelector('.dialog-content').innerHTML = content;
    const footer = this.overlay.querySelector('.dialog-footer');
    footer.replaceChildren();

    let primaryButton = null;
    buttons.forEach((item) => {
      const button = document.createElement('button');
      button.className = `btn ${item.class || ''}`;
      button.textContent = item.text;
      button.addEventListener('click', () => {
        if (item.action) item.action();
        if (item.close !== false) this.hide();
      });
      footer.appendChild(button);
      if (item.class?.includes('btn-primary')) primaryButton = button;
    });

    this.overlay.classList.add('show');
    this.keydownHandler = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.hide();
        return;
      }
      if (event.key === 'Tab') {
        const focusable = [...this.container.querySelectorAll(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )].filter((element) => element.offsetParent !== null);
        if (focusable.length === 0) {
          event.preventDefault();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
      if (event.key === 'Enter' && primaryButton) {
        const tag = (event.target.tagName || '').toLowerCase();
        if (tag === 'textarea' || tag === 'button') return;
        event.preventDefault();
        primaryButton.click();
      }
    };
    document.addEventListener('keydown', this.keydownHandler);
    setTimeout(() => {
      const focusTarget = this.overlay.querySelector('input, textarea, select, button.btn-primary') || primaryButton;
      focusTarget?.focus();
    }, 0);
  },

  hide() {
    if (!this.overlay?.classList.contains('show')) return;
    this.overlay?.classList.remove('show');
    if (this.keydownHandler) {
      document.removeEventListener('keydown', this.keydownHandler);
      this.keydownHandler = null;
    }
    if (this.previousFocus && typeof this.previousFocus.focus === 'function') {
      try { this.previousFocus.focus(); } catch { /* 节点已删除时无需恢复焦点。 */ }
    }
    this.previousFocus = null;
    const onClose = this.closeHandler;
    this.closeHandler = null;
    if (onClose) onClose();
  },

  confirm(title, message, onConfirm, confirmText = '确认', cancelText = '取消', confirmClass = 'btn-primary') {
    this.show(title, `<p>${escapeHtml(message)}</p>`, [
      { text: cancelText, class: 'btn-secondary' },
      { text: confirmText, class: confirmClass, action: onConfirm }
    ]);
  },

  alert(title, message, onClose) {
    this.show(title, `<p>${escapeHtml(message)}</p>`, [
      { text: '确定', class: 'btn-primary', action: onClose }
    ]);
  }
};

export const Toast = {
  stack: null,
  ensureStack() {
    if (this.stack) return this.stack;
    this.stack = document.createElement('div');
    this.stack.className = 'toast-stack';
    this.stack.setAttribute('aria-live', 'polite');
    document.body.appendChild(this.stack);
    return this.stack;
  },
  show(message, type = 'info', durationMs = 3000) {
    const stack = this.ensureStack();
    const element = document.createElement('div');
    element.className = `toast toast-${type}`;
    element.setAttribute('role', type === 'error' ? 'alert' : 'status');
    const icon = type === 'success' ? '✓' : type === 'error' ? '!' : 'i';
    element.innerHTML = `
      <span class="toast-icon" aria-hidden="true">${icon}</span>
      <div class="toast-body"></div>
      <button class="toast-close" aria-label="关闭">×</button>
    `;
    element.querySelector('.toast-body').textContent = message;
    stack.appendChild(element);
    requestAnimationFrame(() => element.classList.add('show'));

    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      element.classList.remove('show');
      setTimeout(() => element.remove(), 250);
    };
    element.querySelector('.toast-close').addEventListener('click', dismiss);
    if (durationMs > 0) setTimeout(dismiss, durationMs);
  },
  success(message) { this.show(message, 'success'); },
  error(message) { this.show(message, 'error', 5000); },
  info(message) { this.show(message, 'info'); }
};

export const Theme = {
  STORAGE_KEY: 'ccop-theme',
  current: 'dark',
  apply(name) {
    this.current = name === 'light' ? 'light' : 'dark';
    document.documentElement.classList.toggle('theme-light', this.current === 'light');
    document.body.classList.toggle('theme-light', this.current === 'light');
    try { localStorage.setItem(this.STORAGE_KEY, this.current); } catch { /* 仅本会话生效。 */ }
    this.updateToggleButton();
  },
  toggle() {
    this.apply(this.current === 'dark' ? 'light' : 'dark');
  },
  updateToggleButton() {
    const button = document.getElementById('themeToggleBtn');
    if (!button) return;
    button.setAttribute('aria-label', this.current === 'dark' ? '切换到亮色主题' : '切换到暗色主题');
    button.innerHTML = this.current === 'dark'
      ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>`
      : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>`;
  },
  init() {
    let saved = 'dark';
    try { saved = localStorage.getItem(this.STORAGE_KEY) || 'dark'; } catch { /* 使用默认主题。 */ }
    this.apply(saved);
  }
};

let infoTooltip = null;
let infoTooltipOwner = null;

function ensureInfoTooltip() {
  if (infoTooltip) return infoTooltip;
  infoTooltip = document.createElement('div');
  infoTooltip.id = 'admin-info-tooltip';
  infoTooltip.className = 'info-tooltip';
  infoTooltip.setAttribute('role', 'tooltip');
  infoTooltip.hidden = true;
  document.body.appendChild(infoTooltip);
  return infoTooltip;
}

function showInfoTooltip(tip) {
  const tooltip = ensureInfoTooltip();
  tooltip.textContent = tip.dataset.tip || '查看配置说明';
  tooltip.hidden = false;
  tooltip.style.left = '0px';
  tooltip.style.top = '0px';
  const anchor = tip.getBoundingClientRect();
  const bounds = tooltip.getBoundingClientRect();
  const left = Math.min(
    window.innerWidth - bounds.width - 16,
    Math.max(16, anchor.left + anchor.width / 2 - bounds.width / 2),
  );
  const preferredTop = anchor.top - bounds.height - 8;
  const top = preferredTop >= 16 ? preferredTop : anchor.bottom + 8;
  tooltip.style.left = `${Math.round(left)}px`;
  tooltip.style.top = `${Math.round(top)}px`;
  infoTooltipOwner = tip;
}

function hideInfoTooltip(tip = null) {
  if (!infoTooltip || (tip && infoTooltipOwner !== tip)) return;
  infoTooltip.hidden = true;
  infoTooltipOwner = null;
}

function setInfoTipOpen(tip, open) {
  tip.classList.toggle('is-open', open);
  tip.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) showInfoTooltip(tip);
  else hideInfoTooltip(tip);
}

export function closeInfoTips(except = null) {
  document.querySelectorAll('.info-tip.is-open').forEach((tip) => {
    if (tip !== except) setInfoTipOpen(tip, false);
  });
  if (!except) hideInfoTooltip();
}

export function enhanceInfoTips(root = document) {
  ensureInfoTooltip();
  root.querySelectorAll('.info-tip').forEach((tip) => {
    if (tip.dataset.enhanced === 'true') return;
    const description = tip.dataset.tip || '查看配置说明';
    tip.dataset.enhanced = 'true';
    tip.setAttribute('role', 'button');
    tip.setAttribute('tabindex', '0');
    tip.setAttribute('aria-label', `配置说明：${description}`);
    tip.setAttribute('aria-expanded', 'false');
    tip.setAttribute('aria-describedby', 'admin-info-tooltip');
    tip.addEventListener('mouseenter', () => showInfoTooltip(tip));
    tip.addEventListener('mouseleave', () => {
      if (!tip.classList.contains('is-open')) hideInfoTooltip(tip);
    });
    tip.addEventListener('focus', () => showInfoTooltip(tip));
    tip.addEventListener('click', (event) => {
      // 提示可能位于 checkbox label 内，必须取消默认行为避免查看说明时切换配置。
      event.preventDefault();
      event.stopPropagation();
      const nextOpen = !tip.classList.contains('is-open');
      closeInfoTips(tip);
      setInfoTipOpen(tip, nextOpen);
    });
    tip.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        tip.click();
      } else if (event.key === 'Escape') {
        // 只关闭说明浮层，Escape 继续冒泡给 Dialog 关闭当前表单。
        setInfoTipOpen(tip, false);
      }
    });
    tip.addEventListener('blur', () => setInfoTipOpen(tip, false));
  });
}
