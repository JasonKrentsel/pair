'use strict';
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

// Deliberately small Markdown subset. Source HTML, images, command links and
// remote content remain inert.
function inlineMarkdown(text) {
  return escape(text).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
}
function markdown(text) {
  const lines = String(text ?? '').split(/\r?\n/), output = [];
  let code, list = false;
  const endList = () => { if (list) { output.push('</ul>'); list = false; } };
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      endList(); if (code) { output.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`); code = undefined; } else code = []; continue;
    }
    if (code) { code.push(line); continue; }
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) { if (!list) { output.push('<ul>'); list = true; } output.push(`<li>${inlineMarkdown(bullet[1])}</li>`); continue; }
    endList(); if (!line.trim()) continue;
    const heading = line.match(/^#{1,4}\s+(.+)$/);
    output.push(heading ? `<h3>${inlineMarkdown(heading[1])}</h3>` : `<p>${inlineMarkdown(line)}</p>`);
  }
  endList(); if (code) output.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`);
  return output.join('');
}

module.exports = { escape, markdown };
