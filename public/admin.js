const MODES = ['random-start', 'random'];
const QUALITIES = ['480p', '720p', '1080p', '2160p'];
const LANGUAGES = ['en', 'es', 'fr', 'de', 'it', 'pt'];

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request to ${url} failed (${res.status})`);
  return data;
}

function selectHtml(field, options, selected) {
  return `<select data-field="${field}">${options.map((o) => `<option value="${o}"${o === selected ? ' selected' : ''}>${o}</option>`).join('')}</select>`;
}

function cssEscape(text) {
  return text.replace(/[^a-zA-Z0-9]/g, '_');
}

function showBanner(message) {
  const banner = document.getElementById('banner');
  banner.textContent = message;
  banner.style.display = 'block';
}

function hideBanner() {
  document.getElementById('banner').style.display = 'none';
}

async function loadChannels() {
  const channels = await fetchJson('/admin/channels');
  const body = document.getElementById('channels-body');
  body.innerHTML = channels.map((ch) => `
    <tr data-id="${ch.id}">
      <td>${ch.name}</td>
      <td>${selectHtml('mode', MODES, ch.mode)}</td>
      <td>${selectHtml('minQuality', QUALITIES, ch.minQuality)}</td>
      <td>${selectHtml('language', LANGUAGES, ch.language)}</td>
      <td><input type="checkbox" data-field="enabled" ${ch.enabled ? 'checked' : ''}></td>
    </tr>
  `).join('');

  body.querySelectorAll('select, input[type=checkbox]').forEach((el) => {
    el.addEventListener('change', async (e) => {
      const row = e.target.closest('tr');
      const id = row.dataset.id;
      const field = e.target.dataset.field;
      const value = field === 'enabled' ? e.target.checked : e.target.value;
      try {
        await fetchJson(`/admin/channels/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [field]: value })
        });
        hideBanner();
        await loadAll();
      } catch (err) {
        showBanner(err.message);
      }
    });
  });
}

async function loadCatalogs() {
  const result = await fetchJson('/admin/catalogs');
  if (result.degraded) {
    showBanner('Could not reach your Stremio account right now — catalog list unavailable.');
  }

  const body = document.getElementById('catalogs-body');
  body.innerHTML = result.catalogs.map((cat) => {
    if (cat.channelId) {
      return `<tr><td>${cat.addonName}</td><td>${cat.catalogName}</td><td>${cat.type}</td><td>Already added</td></tr>`;
    }
    const key = cssEscape(`${cat.addon}::${cat.catalog}`);
    return `
      <tr data-addon="${cat.addon}" data-catalog="${cat.catalog}" data-key="${key}">
        <td>${cat.addonName}</td><td>${cat.catalogName}</td><td>${cat.type}</td>
        <td><button data-action="toggle-form">Add channel</button></td>
      </tr>
      <tr class="add-form-row">
        <td colspan="4">
          <div class="add-form" id="form-${key}">
            <input type="text" data-field="name" placeholder="Channel name" value="${cat.catalogName}">
            ${selectHtml('mode', MODES, 'random-start')}
            ${selectHtml('minQuality', QUALITIES, '720p')}
            ${selectHtml('language', LANGUAGES, 'en')}
            <button data-action="submit">Save</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  body.querySelectorAll('button[data-action="toggle-form"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const row = e.target.closest('tr');
      document.getElementById(`form-${row.dataset.key}`).classList.toggle('open');
    });
  });

  body.querySelectorAll('button[data-action="submit"]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const formDiv = e.target.closest('.add-form');
      const row = formDiv.closest('tr').previousElementSibling;
      const addon = row.dataset.addon;
      const catalog = row.dataset.catalog;
      const name = formDiv.querySelector('[data-field="name"]').value;
      const mode = formDiv.querySelector('[data-field="mode"]').value;
      const minQuality = formDiv.querySelector('[data-field="minQuality"]').value;
      const language = formDiv.querySelector('[data-field="language"]').value;
      try {
        await fetchJson('/admin/channels', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ addon, catalog, name, mode, minQuality, language })
        });
        hideBanner();
        await loadAll();
      } catch (err) {
        showBanner(err.message);
      }
    });
  });
}

async function loadAll() {
  await loadChannels();
  await loadCatalogs();
}

loadAll();
