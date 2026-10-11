/*
 * Hearth dashboard for Home Assistant.
 *
 * Makes the Hearth add-on a regular Home Assistant dashboard, so it can be the
 * default dashboard, appear in the dashboards list and open in the companion
 * apps like any other dashboard.
 *
 *   strategy: custom:hearth  - a whole dashboard that is just Hearth
 *   custom:hearth-card       - the same view as a card, for a panel view
 *
 * Both accept `addon` (the add-on slug, default 632b734c_ha_hearth, which is
 * this repository's Hearth) and `path` (a path inside Hearth, default "/").
 *
 * Hearth is served over Ingress. Like Home Assistant's own add-on panel, the
 * card opens an Ingress session for the signed-in user, keeps it valid while
 * the dashboard is open and renews it when it lapses. Hearth then signs in
 * through the surrounding Home Assistant window, as it does in its panel.
 */

const VERSION = '1.0.0';
const DEFAULT_ADDON = '632b734c_ha_hearth';
const VALIDATE_EVERY_MS = 60_000;

const sessions = new Map(); // one shared Ingress session per page

function setSessionCookie(session) {
	const secure = location.protocol === 'https:' ? ';Secure' : '';
	document.cookie = `ingress_session=${session};path=/api/hassio_ingress/;SameSite=Strict${secure}`;
}

async function createSession(hass) {
	const result = await hass.callWS({
		type: 'supervisor/api',
		endpoint: '/ingress/session',
		method: 'post'
	});
	const session = result.session;
	setSessionCookie(session);
	return session;
}

async function validateSession(hass, session) {
	try {
		await hass.callWS({
			type: 'supervisor/api',
			endpoint: '/ingress/validate_session',
			method: 'post',
			data: { session }
		});
		return true;
	} catch {
		return false;
	}
}

/** The session for this page, created once and shared by every Hearth card. */
function ensureSession(hass) {
	let entry = sessions.get('current');
	if (!entry) {
		entry = { promise: createSession(hass), timer: undefined, users: 0 };
		sessions.set('current', entry);
	}
	return entry;
}

function startKeepAlive(hass, entry) {
	entry.users += 1;
	if (entry.timer) return;
	entry.timer = setInterval(async () => {
		const session = await entry.promise.catch(() => undefined);
		if (session && (await validateSession(hass, session))) return;
		entry.promise = createSession(hass);
	}, VALIDATE_EVERY_MS);
}

function stopKeepAlive(entry) {
	entry.users = Math.max(0, entry.users - 1);
	if (entry.users === 0 && entry.timer) {
		clearInterval(entry.timer);
		entry.timer = undefined;
	}
}

async function ingressUrl(hass, addon) {
	const info = await hass.callWS({
		type: 'supervisor/api',
		endpoint: `/addons/${addon}/info`,
		method: 'get'
	});
	if (!info.ingress_url) throw new Error(`${addon} has no Ingress URL`);
	if (info.state !== 'started') {
		throw new Error(`The Hearth add-on (${addon}) is ${info.state ?? 'not running'}.`);
	}
	return info.ingress_url;
}

class HearthCard extends HTMLElement {
	static getStubConfig() {
		return { addon: DEFAULT_ADDON };
	}

	setConfig(config) {
		this._config = { addon: DEFAULT_ADDON, path: '/', ...config };
		this._loaded = false;
		this._render();
	}

	set hass(hass) {
		const first = !this._hass;
		this._hass = hass;
		if (first || !this._loaded) this._load();
	}

	getCardSize() {
		return 12;
	}

	getGridOptions() {
		return { columns: 'full', rows: 12 };
	}

	connectedCallback() {
		if (this._hass && !this._entry) this._load();
	}

	disconnectedCallback() {
		if (this._entry) stopKeepAlive(this._entry);
		this._entry = undefined;
		this._loaded = false;
	}

	_render() {
		if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
		this.shadowRoot.innerHTML = `
			<style>
				:host {
					display: block;
					height: 100%;
					min-height: calc(100vh - var(--header-height, 56px) - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
					background: var(--primary-background-color);
				}
				iframe {
					display: block;
					width: 100%;
					height: 100%;
					min-height: inherit;
					border: 0;
					background: transparent;
				}
				.message {
					padding: 24px;
					color: var(--primary-text-color);
					font-family: var(--paper-font-body1_-_font-family, inherit);
				}
				.message small { color: var(--secondary-text-color); display: block; margin-top: 8px; }
			</style>
			<div class="message">Loading Hearth…</div>`;
	}

	_showError(error) {
		const text = error?.message ?? String(error);
		this.shadowRoot.innerHTML = `
			<style>.message{padding:24px;color:var(--primary-text-color)}small{display:block;margin-top:8px;color:var(--secondary-text-color)}</style>
			<div class="message">Hearth could not be opened.<small>${text.replace(/</g, '&lt;')}</small></div>`;
	}

	async _load() {
		if (!this._hass || !this._config || this._loading || !this.isConnected) return;
		this._loading = true;
		try {
			const entry = ensureSession(this._hass);
			if (!this._entry) {
				this._entry = entry;
				startKeepAlive(this._hass, entry);
			}
			await entry.promise;
			const base = await ingressUrl(this._hass, this._config.addon);
			const path = String(this._config.path || '/').replace(/^\/+/, '');
			const src = base.replace(/\/?$/, '/') + path;
			const existing = this.shadowRoot.querySelector('iframe');
			if (existing && existing.dataset.src === src) {
				this._loaded = true;
				return;
			}
			this._render();
			const frame = document.createElement('iframe');
			frame.title = 'Hearth';
			frame.dataset.src = src;
			frame.src = src;
			frame.allow = 'fullscreen; autoplay; clipboard-read; clipboard-write; screen-wake-lock';
			this.shadowRoot.querySelector('.message').replaceWith(frame);
			this._loaded = true;
		} catch (error) {
			console.error('Hearth dashboard:', error);
			this._showError(error);
		} finally {
			this._loading = false;
		}
	}
}

class HearthDashboardStrategy extends HTMLElement {
	static async generate(config) {
		const card = { type: 'custom:hearth-card' };
		if (config.addon) card.addon = config.addon;
		if (config.path) card.path = config.path;
		return {
			title: config.title ?? 'Hearth',
			views: [
				{
					title: config.title ?? 'Hearth',
					path: 'hearth',
					type: 'panel',
					cards: [card]
				}
			]
		};
	}
}

if (!customElements.get('hearth-card')) customElements.define('hearth-card', HearthCard);
if (!customElements.get('ll-strategy-dashboard-hearth')) {
	customElements.define('ll-strategy-dashboard-hearth', HearthDashboardStrategy);
}

window.customCards = window.customCards || [];
if (!window.customCards.some((card) => card.type === 'hearth-card')) {
	window.customCards.push({
		type: 'hearth-card',
		name: 'Hearth',
		description: 'The Hearth dashboard, embedded as a full-screen card.',
		preview: false
	});
}

console.info(`%c HEARTH-DASHBOARD %c ${VERSION} `, 'background:#e8743b;color:#fff', 'background:#333;color:#fff');
