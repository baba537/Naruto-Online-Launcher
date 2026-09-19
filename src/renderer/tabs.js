'use strict';

(function () {
  const tabsEl = document.getElementById('tabs');
  let labels = {};

  const ICONS = {
    sound: 'M3 9v6h4l5 4V5L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z',
    muted: 'M3 9v6h4l5 4V5L7 9H3zm18.3.7-1.4-1.4-2.4 2.3-2.4-2.3-1.4 1.4 2.4 2.3-2.4 2.3 1.4 1.4 2.4-2.3 2.4 2.3 1.4-1.4-2.4-2.3z',
    close: 'M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6L19 6.4 17.6 5 12 10.6z'
  };

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    return node;
  }

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ICONS[name]);
    svg.append(path);
    return svg;
  }

  function button(iconName, title, onClick) {
    const b = el('button');
    b.type = 'button';
    b.title = title || '';
    b.append(icon(iconName));
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  function render(state) {
    labels = state.labels || labels;
    document.getElementById('launcher').title = labels.launcher || '';
    tabsEl.replaceChildren();
    for (const tab of state.tabs) {
      const node = el('div', `tab${tab.active ? ' active' : ''}`);
      node.title = tab.label;
      node.append(
        el('span', `dot ${tab.login}`),
        el('span', 'label', tab.label),
        button(tab.muted ? 'muted' : 'sound', tab.muted ? labels.unmute : labels.mute, () => window.strip.mute(tab.id)),
        button('close', labels.close, () => window.strip.close(tab.id))
      );
      node.addEventListener('click', () => window.strip.select(tab.id));
      node.addEventListener('auxclick', (e) => e.button === 1 && window.strip.close(tab.id));
      tabsEl.append(node);
    }
  }

  document.getElementById('launcher').addEventListener('click', () => window.strip.showLauncher());
  window.strip.onState(render);
  window.strip.ready();
})();
