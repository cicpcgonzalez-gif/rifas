const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const { v4: uuid } = require('uuid');
const { PrismaClient } = require('@prisma/client');
const { Expo } = require('expo-server-sdk');
require('dotenv').config();

const app = express();
const expo = new Expo();
const PORT = process.env.PORT || 4000;
const SUPERADMIN_EMAIL = (process.env.SUPERADMIN_EMAIL || 'rifa@megarifasapp.com').toLowerCase();
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const ACCESS_TOKEN_TTL = '10m';
const REFRESH_TOKEN_TTL = '30d';
const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_TICKETS = 10000;
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_BLOCK_WINDOW_MS = 15 * 60 * 1000;
const VERIFY_BASE_URL = process.env.VERIFY_BASE_URL || 'https://megarifasapp.com/verify';
const RATE_LIMITS = {
	login: { windowMs: 5 * 60 * 1000, limit: 7 },
	sensitive: { windowMs: 5 * 60 * 1000, limit: 30 }
};

// In-memory storage to keep the example simple.
const db = {
	users: [],
	raffles: [],
	purchases: [], // { id, raffleId, userId, numbers: [int], amount, buyer, status, createdAt, via }
	manualPayments: [], // { id, raffleId, userId, quantity, status, proof, reference, note, createdAt, numbers? }
	wallets: {}, // userId -> { balance }
	loginAttempts: new Map(), // email -> { attempts, blockedUntil }
	refreshTokens: new Map(), // token -> userId
	activityLogs: [], // { id, action, userId, organizerId, meta, createdAt }
	twoFactor: new Map(), // userId -> { code, expiresAt }
	recoveryTokens: new Map(), // token -> { userId, expiresAt }
	verificationTokens: new Map(), // token -> { userId, expiresAt }
	passwordResetTokens: new Map(), // token -> { userId, expiresAt }
	mailLogs: [] // { id, to, subject, status, error, timestamp, provider }
};

const prisma = new PrismaClient();

const createRateLimiter = (name, windowMs, limit) => {
	const bucket = new Map();
	const middleware = (req, res, next) => {
		const key = req.ip || req.headers['x-forwarded-for'] || 'global';
		const now = Date.now();
		const entry = bucket.get(key) || { count: 0, resetAt: now + windowMs };
		if (entry.resetAt < now) {
			entry.count = 0;
			entry.resetAt = now + windowMs;
		}
		entry.count += 1;
		bucket.set(key, entry);
		if (entry.count > limit) return res.status(429).json({ error: 'Demasiados intentos. Intenta más tarde.' });
		return next();
	};
	middleware.bucketName = name;
	return middleware;
};

const limitLogin = createRateLimiter('login', RATE_LIMITS.login.windowMs, RATE_LIMITS.login.limit);
const limitSensitive = createRateLimiter('sensitive', RATE_LIMITS.sensitive.windowMs, RATE_LIMITS.sensitive.limit);

// Seed demo user so it can iniciar sesión sin verificaciones extra.
const seedDemoUsers = () => {
	const email = 'cicpcgonzalez@gmail.com';
	const existing = db.users.find((u) => u.email === email);
	if (existing) return existing;

	const password = '123456789';
	const hashed = bcrypt.hashSync(password, 10);
	const secCode = generateSecurityCode();
	const secHash = bcrypt.hashSync(secCode, 10);
	const user = {
		id: uuid(),
		email,
		password: hashed,
		role: 'admin',
		verified: false,
		isVerified: false,
		active: true,
		organizerId: generateOrganizerId(),
		phone: '+584000000000',
		address: 'Demo',
		firstName: 'Admin',
		lastName: 'Seed',
		support: { whatsapp: '+584000000000', instagram: '@rifas_admin' },
		securityCodeHash: secHash,
		securityCodeUpdatedAt: Date.now()
	};
	db.users.push(user);
	db.wallets[user.id] = { balance: 0 };
	// eslint-disable-next-line no-console
	console.log('Admin seed security code:', secCode);
	return user;
};

const seedSuperAdmin = () => {
	const email = process.env.SUPERADMIN_EMAIL || 'rifa@megarifasapp.com';
	const password = process.env.SUPERADMIN_PASSWORD || 'rifasadmin123';
	const existing = db.users.find((u) => u.email === email && u.role === 'superadmin');
	if (existing) return existing;
	const hashed = bcrypt.hashSync(password, 12);
	const secCode = generateSecurityCode();
	const secHash = bcrypt.hashSync(secCode, 10);
	const user = {
		id: uuid(),
		email,
		password: hashed,
		role: 'superadmin',
		verified: true,
		isVerified: true,
		active: true,
		organizerId: 'SUPERADMIN',
		phone: '+10000000000',
		address: 'HQ',
		firstName: 'Super',
		lastName: 'Admin',
		support: { email, whatsapp: '', instagram: '', website: 'https://megarifasapp.com' },
		securityCodeHash: secHash,
		securityCodeUpdatedAt: Date.now(),
		twoFactorEnabled: false
	};
	db.users.push(user);
	db.wallets[user.id] = { balance: 0 };
	// eslint-disable-next-line no-console
	console.log('Superadmin listo. Email:', email, 'Password:', password, 'Security code:', secCode);
	return user;
};

const seedDemoRaffles = (creatorId) => {
	if (!creatorId) return;
	const creator = db.users.find((u) => u.id === creatorId);
	const presets = [
		{
			title: 'Rifas Sergio Palomino',
			description: 'Premios tech y gadgets cada semana.',
			price: 5,
			totalTickets: 500,
			style: {
				bannerImage: 'https://images.unsplash.com/photo-1511512578047-dfb367046420?auto=format&fit=crop&w=1000&q=60',
				themeColor: '#2563eb',
				accentColor: '#22c55e',
				headline: 'Gana ya',
				ctaText: 'Compra tu número'
			}
		},
		{
			title: 'Rifas Gato',
			description: 'Electrodomésticos y hogar.',
			price: 3,
			totalTickets: 400,
			style: {
				bannerImage: 'https://images.unsplash.com/photo-1503602642458-232111445657?auto=format&fit=crop&w=1000&q=60',
				themeColor: '#ea580c',
				accentColor: '#fbbf24',
				headline: 'Sorteos semanales',
				ctaText: 'Participa ahora'
			}
		},
		{
			title: 'Rifas Adrián',
			description: 'Moda y accesorios premium.',
			price: 4,
			totalTickets: 350,
			style: {
				bannerImage: 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?auto=format&fit=crop&w=1000&q=60',
				themeColor: '#7c3aed',
				accentColor: '#22d3ee',
				headline: 'Ediciones limitadas',
				ctaText: 'Aprovecha hoy'
			}
		}
	];

	presets.forEach((preset) => {
		const exists = db.raffles.find((r) => r.title === preset.title);
		if (exists) return;
		const raffle = {
			id: uuid(),
			title: preset.title,
			description: preset.description,
			price: preset.price,
			creatorId,
			organizerId: creator?.organizerId,
			status: 'active',
			winningTicketNumber: null,
			nextTicket: 1,
			createdAt: Date.now(),
			startDate: new Date().toISOString(),
			endDate: null,
			totalTickets: preset.totalTickets || MAX_TICKETS,
			style: preset.style
		};
		db.raffles.push(raffle);
	});
};

app.use(cors());
app.use(express.json());
app.use(morgan('dev'));
app.use((req, res, next) => {
	const reqId = req.headers['x-request-id'] || uuid();
	req.id = reqId;
	res.setHeader('x-request-id', reqId);
	res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
	return next();
});

// Pre-carga de datos: solo superadmin requerido.
const superAdminUser = seedSuperAdmin();

const sanitizeNumber = (value) => Number.parseInt(value, 10);
const formatTicketNumber = (value) => String(value).padStart(4, '0');
const parseTicketNumber = (value) => {
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const signAccessToken = (payload) => jwt.sign({ ...payload, type: 'access' }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL });
const signRefreshToken = (payload) => jwt.sign({ ...payload, type: 'refresh' }, JWT_SECRET, { expiresIn: REFRESH_TOKEN_TTL });

const getRaffleCapacity = (raffle) => {
	const total = Number(raffle?.totalTickets);
	if (Number.isFinite(total) && total > 0) return Math.min(total, MAX_TICKETS);
	return MAX_TICKETS;
};

const getAssignedNumbers = (raffleId) => {
	const assigned = new Set();
	const addIfValid = (value) => {
		const parsed = parseTicketNumber(value);
		if (parsed) assigned.add(parsed);
	};
	db.purchases
		.filter((p) => p.raffleId === raffleId && p.status === 'approved')
		.forEach((p) => (p.numbers || []).forEach(addIfValid));
	db.manualPayments
		.filter((m) => m.raffleId === raffleId && m.status === 'approved' && Array.isArray(m.numbers))
		.forEach((m) => m.numbers.forEach(addIfValid));
	return assigned;
};

const allocateRandomNumbers = (raffle, quantity) => {
	const capacity = getRaffleCapacity(raffle);
	const assigned = getAssignedNumbers(raffle.id);
	const available = capacity - assigned.size;
	if (!Number.isFinite(quantity) || quantity <= 0) return null;
	if (quantity > available) return null;
	const pool = [];
	for (let i = 1; i <= capacity; i += 1) {
		if (!assigned.has(i)) pool.push(i);
	}
	const numbers = [];
	for (let i = 0; i < quantity; i += 1) {
		const idx = Math.floor(Math.random() * pool.length);
		numbers.push(pool[idx]);
		pool.splice(idx, 1);
	}
	numbers.sort((a, b) => a - b);
	return numbers;
};

const getRaffleProgress = (raffle) => {
	const capacity = getRaffleCapacity(raffle);
	const sold = getAssignedNumbers(raffle.id).size;
	const remaining = Math.max(0, capacity - sold);
	const progress = capacity > 0 ? Math.min(1, sold / capacity) : 0;
	return { sold, remaining, capacity, progress };
};

const issueTokens = (user) => {
	const accessToken = signAccessToken(user);
	const refreshToken = signRefreshToken({ id: user.id });
	db.refreshTokens.set(refreshToken, user.id);
	return { accessToken, refreshToken };
};

const revokeUserRefreshTokens = (userId) => {
	if (!userId) return;
	Array.from(db.refreshTokens.entries())
		.filter(([, uid]) => uid === userId)
		.forEach(([tkn]) => db.refreshTokens.delete(tkn));
};

const validateEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
const validatePhone = (phone) => /^(\+?\d{10,15})$/.test(String(phone || '').trim());
const validateCedula = (id) => /^\d{6,12}$/.test(String(id || '').trim());
const isIsoDate = (value) => !Number.isNaN(Date.parse(value));
const generateOrganizerId = () => `ORG-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const generate2FACode = () => Math.floor(100000 + Math.random() * 900000).toString();
const generateVerificationCode = () => Math.floor(100000 + Math.random() * 900000).toString();
function generateSecurityCode() {
	return Math.random().toString(36).slice(2, 10).toUpperCase();
}

const ensureAdminSecurityCode = (userRecord) => {
	if (!userRecord || (!['admin', 'organizer', 'superadmin'].includes(userRecord.role))) return null;
	if (userRecord.securityCodeHash) return null;
	const code = generateSecurityCode();
	userRecord.securityCodeHash = bcrypt.hashSync(code, 10);
	userRecord.securityCodeUpdatedAt = Date.now();
	sendEmail({
		to: userRecord.email,
		subject: 'Tu código de seguridad',
		html: `<p>Tu nuevo código de seguridad es <strong>${code}</strong>. Guárdalo de forma segura.</p>`
	});
	return code;
};

const markUserVerified = (userRecord) => {
	if (!userRecord) return;
	userRecord.verified = true;
	userRecord.isVerified = true;
};

const clearUserVerificationTokens = (userId) => {
	if (!userId) return;
	for (const [code, payload] of db.verificationTokens.entries()) {
		if (payload?.userId === userId) db.verificationTokens.delete(code);
	}
};

const logActivity = ({ action, userId, organizerId, meta = {} }) => {
	db.activityLogs.push({ id: uuid(), action, userId, organizerId, meta, createdAt: Date.now() });
};

const snapshotBuyer = (user) => {
	if (!user) return null;
	return {
		firstName: user.firstName,
		lastName: user.lastName,
		email: user.email,
		phone: user.phone,
		cedula: user.cedula,
		address: user.address
	};
};

const registerFailedAttempt = (email) => {
	const now = Date.now();
	const entry = db.loginAttempts.get(email) || { attempts: 0, blockedUntil: 0 };
	if (entry.blockedUntil && entry.blockedUntil > now) return entry;
	entry.attempts += 1;
	if (entry.attempts >= MAX_LOGIN_ATTEMPTS) {
		entry.blockedUntil = now + LOGIN_BLOCK_WINDOW_MS;
	}
	db.loginAttempts.set(email, entry);
	return entry;
};

const registerSuccessAttempt = (email) => {
	db.loginAttempts.delete(email);
};

const MAIL_DOMAIN = process.env.MAIL_DOMAIN || 'megarifasapp.com';
const DEFAULT_FROM = process.env.MAIL_FROM || `rifa@${MAIL_DOMAIN}`;

const platformSettings = {
	email: {
		domain: MAIL_DOMAIN,
		from: DEFAULT_FROM
	},
	branding: {
		logoUrl: '',
		bannerUrl: '',
		primaryColor: '#2563eb',
		secondaryColor: '#0ea5e9',
		tagline: 'La mejor experiencia en rifas',
		title: 'MegaRifas',
		policies: 'Participa siempre con responsabilidad.'
	},
	modules: {
		user: { raffles: true, wallet: true, profile: true, support: true },
		admin: { raffles: true, wallet: true, profile: true, manualPayments: true },
		superadmin: { branding: true, modules: true, audit: true }
	}
};

const getMailDomain = () => platformSettings.email.domain || MAIL_DOMAIN;
const getDefaultFrom = () => platformSettings.email.from || DEFAULT_FROM || `rifa@${getMailDomain()}`;


const createMailer = () => {
	const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE } = process.env;
	if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
		return nodemailer.createTransport({
			host: SMTP_HOST,
			port: Number(SMTP_PORT) || 587,
			secure: SMTP_SECURE === 'true',
			auth: { user: SMTP_USER, pass: SMTP_PASS }
		});
	}
	// Fallback that just logs emails to console for demo purposes.
	return nodemailer.createTransport({ jsonTransport: true });
};

const mailer = createMailer();

const sendEmail = async ({ to, subject, html, from, replyTo }) => {
	try {
		const info = await mailer.sendMail({
			from: from || getDefaultFrom(),
			replyTo,
			to,
			subject,
			html
		});
		db.mailLogs.push({ id: uuid(), to, subject, status: 'sent', provider: info?.envelope?.from || 'mailer', timestamp: Date.now(), error: null });
	} catch (err) {
		const errorDetail = [err?.message, err?.response?.toString?.(), err?.code].filter(Boolean).join(' | ');
		// eslint-disable-next-line no-console
		console.error('No se pudo enviar correo:', errorDetail);
		db.mailLogs.push({ id: uuid(), to, subject, status: 'failed', provider: 'mailer', timestamp: Date.now(), error: errorDetail });
	}
};

const buildOrganizerSender = (organizer) => {
	const domain = getMailDomain();
	if (!organizer) return { from: getDefaultFrom() };
	const displayName = [organizer.firstName, organizer.lastName].filter(Boolean).join(' ') || 'Organizador';
	const local = (organizer.organizerId || organizer.id || 'organizador').replace(/[^a-zA-Z0-9._-]/g, '').toLowerCase() || 'organizador';
	const from = `${displayName} | Rifas <${local}@${domain}>`;
	const replyTo = organizer.support?.email || organizer.email || undefined;
	return { from, replyTo };
};

const buildContactItems = (organizer) => {
	const items = [];
	if (organizer?.phone) items.push({ label: 'Teléfono', value: organizer.phone });
	const support = organizer?.support || {};
	if (support.whatsapp) items.push({ label: 'WhatsApp', value: support.whatsapp });
	if (support.instagram) items.push({ label: 'Instagram', value: support.instagram });
	if (support.facebook) items.push({ label: 'Facebook', value: support.facebook });
	if (support.tiktok) items.push({ label: 'TikTok', value: support.tiktok });
	if (support.website) items.push({ label: 'Web', value: support.website });
	if (support.email) items.push({ label: 'Correo', value: support.email });
	return items;
};

const renderTicketEmail = ({ buyerName, raffleTitle, numbers, purchaseDate, bannerImage, contactItems, organizerName }) => {
	const formattedDate = new Date(purchaseDate || Date.now()).toLocaleString('es-ES', { hour12: false });
	const ticketBlocks = (numbers || []).map((n) => `<div class="ticket-box">${n}</div>`).join('');
	const contacts = (contactItems || []).length
		? contactItems.map((item) => `<li><strong>${item.label}:</strong> ${item.value}</li>`).join('')
		: '<li>El administrador no ha configurado datos de contacto.</li>';
	const safeBanner = bannerImage || 'https://images.unsplash.com/photo-1511512578047-dfb367046420?auto=format&fit=crop&w=1200&q=80';
	const mailDomain = getMailDomain();

	return `<!doctype html>
<html lang="es">
<head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<style>
		:root { --bg:#f4f6fb; --card:#ffffff; --text:#111827; --muted:#6b7280; --primary:#2563eb; --accent:#0ea5e9; }
		body { margin:0; background:var(--bg); font-family:'Helvetica Neue', Arial, sans-serif; color:var(--text); padding:24px; }
		.wrapper { max-width:640px; margin:0 auto; }
		.card { background:var(--card); border-radius:20px; box-shadow:0 12px 32px rgba(15,23,42,0.08); overflow:hidden; }
		.banner { width:100%; height:220px; object-fit:cover; display:block; }
		.content { padding:24px; }
		h1 { margin:0 0 8px; font-size:24px; }
		p { margin:6px 0 12px; line-height:1.6; }
		.meta { margin:16px 0; padding:16px; background:linear-gradient(135deg, rgba(37,99,235,0.08), rgba(14,165,233,0.08)); border-radius:14px; }
		.meta-row { display:flex; justify-content:space-between; font-weight:600; }
		.meta-label { color:var(--muted); font-weight:500; }
		.tickets { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:12px; margin:18px 0; }
		.ticket-box { padding:14px; border-radius:12px; background:linear-gradient(135deg, #0ea5e9, #2563eb); color:#fff; text-align:center; font-size:22px; font-weight:700; letter-spacing:0.5px; box-shadow:0 8px 18px rgba(37,99,235,0.25); }
		.contact { margin-top:12px; padding:16px; border:1px solid rgba(15,23,42,0.08); border-radius:14px; }
		.contact h3 { margin:0 0 8px; font-size:16px; }
		.contact ul { padding-left:18px; margin:0; color:var(--muted); }
		.footer { text-align:center; color:var(--muted); font-size:12px; margin:18px 0 6px; }
		@media (max-width:640px) { body { padding:12px; } .banner { height:180px; } }
	</style>
</head>
<body>
	<div class="wrapper">
		<div class="card">
			<img src="${safeBanner}" alt="Rifa ${raffleTitle}" class="banner" />
			<div class="content">
				<h1>${raffleTitle}</h1>
				<p>Hola ${buyerName || 'comprador'},</p>
				<p>Gracias por tu compra, tu ticket ha sido registrado correctamente.</p>
				<div class="meta">
					<div class="meta-row"><span class="meta-label">Fecha y hora</span><span>${formattedDate}</span></div>
					<div class="meta-row"><span class="meta-label">Administrador</span><span>${organizerName}</span></div>
				</div>
				<p>Números asignados:</p>
				<div class="tickets">${ticketBlocks}</div>
				<div class="contact">
					<h3>Contacto del administrador</h3>
					<ul>${contacts}</ul>
				</div>
				<p style="margin-top:16px; color:var(--muted);">Si tienes dudas, responde a este correo o usa los datos de contacto del administrador.</p>
			</div>
		</div>
		<div class="footer">Enviado con la identidad del administrador via ${mailDomain}</div>
	</div>
</body>
</html>`;
};

const renderRegistrationEmail = ({ name }) => {
	const displayName = name || 'Bienvenido a MegaRifas';
	const banner = platformSettings.branding.bannerUrl || 'https://images.unsplash.com/photo-1511512578047-dfb367046420?auto=format&fit=crop&w=1200&q=80';
	const logo = platformSettings.branding.logoUrl || '';
	const primary = platformSettings.branding.primaryColor || '#2563eb';
	const mailDomain = getMailDomain();
	const sender = getDefaultFrom();
	return `<!doctype html>
<html lang="es">
<head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<style>
		:root { --bg:#f4f6fb; --card:#ffffff; --text:#0f172a; --muted:#64748b; --primary:${primary}; }
		body { margin:0; padding:24px; background:var(--bg); font-family:'Helvetica Neue', Arial, sans-serif; color:var(--text); }
		.wrapper { max-width:640px; margin:0 auto; }
		.card { background:var(--card); border-radius:18px; box-shadow:0 12px 32px rgba(15,23,42,0.08); overflow:hidden; }
		.banner { width:100%; height:200px; object-fit:cover; display:block; }
		.content { padding:22px; }
		h1 { margin:0 0 10px; font-size:24px; }
		p { margin:8px 0; line-height:1.6; }
		.cta { margin-top:16px; display:inline-block; padding:12px 18px; background:var(--primary); color:#fff; border-radius:10px; text-decoration:none; font-weight:700; }
		.footer { text-align:center; color:var(--muted); font-size:12px; margin-top:18px; }
		@media (max-width:640px) { body { padding:12px; } .banner { height:170px; } }
	</style>
</head>
<body>
	<div class="wrapper">
		<div class="card">
			<img src="${banner}" alt="MegaRifas" class="banner" />
			<div class="content">
				${logo ? `<div style="margin-bottom:12px;"><img src="${logo}" alt="Logo" style="height:38px;" /></div>` : ''}
				<h1>¡Bienvenido a MegaRifas!</h1>
				<p>Hola ${displayName}, gracias por registrarte. Tu cuenta ha sido creada correctamente.</p>
				<p>${platformSettings.branding.tagline || 'Desde hoy puedes explorar rifas, comprar tickets y seguir tus números desde tu panel.'}</p>
				<a class="cta" href="${process.env.APP_URL || 'https://megarifasapp.com'}">Ir a MegaRifas</a>
				<p style="color:var(--muted); margin-top:14px;">Si no creaste esta cuenta, ignora este correo.</p>
			</div>
		</div>
		<div class="footer">Enviado desde ${sender} vía ${mailDomain}</div>
	</div>
</body>
</html>`;
};

const sendRegistrationEmail = ({ to, name }) => {
	return sendEmail({
		to,
		subject: 'Registro completado - MegaRifas',
		html: renderRegistrationEmail({ name }),
		from: getDefaultFrom()
	});
};

const sendTicketConfirmationEmail = ({ buyer, raffle, numbers, organizer, purchaseDate }) => {
	if (!buyer?.email) return;
	const { from, replyTo } = buildOrganizerSender(organizer);
	const contactItems = buildContactItems(organizer);
	const organizerName = [organizer?.firstName, organizer?.lastName].filter(Boolean).join(' ') || 'Administrador de la rifa';
	const html = renderTicketEmail({
		buyerName: [buyer.firstName, buyer.lastName].filter(Boolean).join(' '),
		raffleTitle: raffle?.title || 'Rifa',
		numbers,
		purchaseDate,
		bannerImage: raffle?.style?.bannerImage,
		contactItems,
		organizerName
	});

	return sendEmail({
		to: buyer.email,
		subject: `Confirmación de compra - ${raffle?.title || 'Rifa'}`,
		html,
		from,
		replyTo
	});
};

const authMiddleware = (req, res, next) => {
	const header = req.headers.authorization || '';
	const token = header.startsWith('Bearer ') ? header.slice(7) : null;
	if (!token) return res.status(401).json({ error: 'Token requerido' });
	try {
		const payload = jwt.verify(token, JWT_SECRET);
		if (payload.type !== 'access') return res.status(401).json({ error: 'Token invalido' });
		req.user = payload;
		return next();
	} catch (err) {
		return res.status(401).json({ error: 'Token invalido' });
	}
};

const isSuperAdmin = (user) => user?.role === 'superadmin';
const isAdminOrSuper = (user) => user && (user.role === 'admin' || user.role === 'superadmin');

const adminMiddleware = (req, res, next) => {
	if (!isAdminOrSuper(req.user)) return res.status(403).json({ error: 'Requiere rol administrador' });
	return next();
};

const superadminMiddleware = (req, res, next) => {
	if (!isSuperAdmin(req.user)) return res.status(403).json({ error: 'Requiere rol superadmin' });
	return next();
};

app.get('/health', (_req, res) => {
	res.json({ ok: true, message: 'API viva' });
});

app.get('/api/status', (_req, res) => {
	res.json({ ok: true, message: 'API viva', timestamp: Date.now() });
});

// Endpoint de rifas usando Prisma
app.get('/api/raffles', async (_req, res) => {
  try {
    const raffles = await prisma.raffle.findMany();
    res.json({ raffles });
  } catch (error) {
    console.error('Error al consultar rifas:', error);
    res.status(500).json({ error: 'Error al consultar rifas' });
  }
});

app.post('/auth/register', async (req, res) => {
	const { email, password, firstName, lastName, address, dob, cedula, phone } = req.body || {};
	if (!email || !password || !firstName || !lastName || !address || !dob || !cedula || !phone)
		return res.status(400).json({ error: 'Todos los campos son requeridos' });
	if (!validateEmail(email)) return res.status(400).json({ error: 'Email invalido' });
	if (!password || String(password).length < 8) return res.status(400).json({ error: 'Password muy corto (min 8)' });
	if (!validatePhone(phone)) return res.status(400).json({ error: 'Telefono invalido (usa solo digitos y opcional +)' });
	if (!validateCedula(cedula)) return res.status(400).json({ error: 'Cedula invalida' });
	if (!isIsoDate(dob)) return res.status(400).json({ error: 'Fecha de nacimiento invalida' });
	if (String(password).length < 8) return res.status(400).json({ error: 'Password muy corto (min 8)' });
	if (db.users.some((u) => u.email === email)) return res.status(409).json({ error: 'El email ya esta registrado' });

	const hashed = bcrypt.hashSync(password, 12);
	const user = {
		id: uuid(),
		email,
		role: 'user',
		verified: false,
		isVerified: false,
		active: true,
		organizerId: generateOrganizerId(),
		firstName: String(firstName).trim(),
		lastName: String(lastName).trim(),
		address: String(address).trim(),
		dob: new Date(dob).toISOString(),
		cedula: String(cedula).trim(),
		phone: String(phone).trim(),
		support: {},
		createdAt: Date.now()
	};
	db.users.push({ ...user, password: hashed });
	db.wallets[user.id] = { balance: 0 };
	logActivity({ action: 'user.register', userId: user.id, organizerId: user.organizerId, meta: { email: user.email } });

	clearUserVerificationTokens(user.id);
	let code = generateVerificationCode();
	while (db.verificationTokens.has(code)) {
		code = generateVerificationCode();
	}
	const expiresAt = Date.now() + VERIFICATION_TOKEN_TTL_MS;
	db.verificationTokens.set(code, { userId: user.id, expiresAt });
	await sendEmail({
		to: email,
		subject: 'Tu código de verificación',
		html: `<p>Tu código de verificación es:</p><p style="font-size:20px;font-weight:bold;letter-spacing:2px;">${code}</p><p>Ingresa este código en la app para activar tu cuenta (24h).</p><p>Si no solicitaste esta cuenta, ignora este mensaje.</p>`
	});
	logActivity({ action: 'auth.verify.sent', userId: user.id, organizerId: user.organizerId, meta: { code, expiresAt } });
	await sendRegistrationEmail({ to: email, name: user.firstName });

	return res.json({ message: 'Registro recibido. Revisa tu correo para activar la cuenta.' });
});

app.post('/auth/login', limitLogin, (req, res) => {
	const { email, password } = req.body || {};
	if (!validateEmail(email)) return res.status(400).json({ error: 'Email invalido' });
	const attempt = db.loginAttempts.get(email);
	const now = Date.now();
	if (attempt?.blockedUntil && attempt.blockedUntil > now)
		return res.status(429).json({ error: 'Intentos excedidos, intenta más tarde' });
	const record = db.users.find((u) => u.email === email);
	if (!record) {
		registerFailedAttempt(email);
		return res.status(401).json({ error: 'Credenciales invalidas' });
	}
	if (!record.isVerified && !record.verified) {
		logActivity({ action: 'auth.login.blocked.unverified', userId: record.id, organizerId: record.organizerId });
		return res.status(401).json({ error: 'Debes confirmar tu cuenta con el código enviado a tu correo' });
	}
	if (record.active === false) return res.status(403).json({ error: 'Cuenta desactivada por administrador' });
	const valid = bcrypt.compareSync(password || '', record.password);
	if (!valid) {
		registerFailedAttempt(email);
		return res.status(401).json({ error: 'Credenciales invalidas' });
	}
	if (!record.isVerified && !record.verified) return res.status(401).json({ error: 'Cuenta no verificada' });
	registerSuccessAttempt(email);

	const user = {
		id: record.id,
		email: record.email,
		role: record.role || 'user',
		firstName: record.firstName,
		lastName: record.lastName,
		address: record.address,
		dob: record.dob,
		cedula: record.cedula,
		phone: record.phone,
		organizerId: record.organizerId,
		support: record.support || {}
	};
	const maybeCode = ensureAdminSecurityCode(record);
	const isSuperadminNo2FA = record.email?.toLowerCase() === SUPERADMIN_EMAIL;
	if (isSuperadminNo2FA) {
		record.twoFactorEnabled = false;
		db.twoFactor.delete(record.id);
	}
	const needs2FA = !isSuperadminNo2FA && (user.role === 'admin' || user.role === 'organizer' || user.role === 'superadmin');
	if (needs2FA) {
		const code = generate2FACode();
		db.twoFactor.set(user.id, { code, expiresAt: Date.now() + 5 * 60 * 1000 });
		sendEmail({
			to: user.email,
			subject: 'Tu código 2FA',
			html: `<p>Tu código es <strong>${code}</strong> (5 minutos de validez).</p>`
		});
		logActivity({ action: 'auth.2fa.sent', userId: user.id, organizerId: record.organizerId });
		return res.json({ require2fa: true, userId: user.id, message: 'Código enviado al correo' });
	}

	const tokens = issueTokens(user);
	logActivity({ action: 'auth.login', userId: user.id, organizerId: record.organizerId });
	return res.json({ ...tokens, user, securityCode: maybeCode });
});

// Recuperación con código de seguridad (solo admins/organizadores).
app.post('/auth/recovery/start', async (req, res) => {
	const { email, securityCode } = req.body || {};
	if (!validateEmail(email)) return res.status(400).json({ error: 'Email invalido' });
	if (!securityCode) return res.status(400).json({ error: 'Código requerido' });
	const user = db.users.find((u) => u.email === email && (u.role === 'admin' || u.role === 'organizer'));
	if (!user || !user.securityCodeHash) return res.status(404).json({ error: 'Usuario no encontrado' });
	const valid = bcrypt.compareSync(String(securityCode), user.securityCodeHash);
	if (!valid) return res.status(401).json({ error: 'Código incorrecto' });

	const token = uuid();
	const expiresAt = Date.now() + 15 * 60 * 1000;
	db.recoveryTokens.set(token, { userId: user.id, expiresAt });
	const link = `${process.env.APP_URL || 'https://rifas.local'}/recover?token=${token}`;
	sendEmail({
		to: user.email,
		subject: 'Recuperación de cuenta',
		html: `<p>Recibimos una solicitud de recuperación.</p><p>Usa este enlace por 15 minutos: <a href="${link}">${link}</a></p>`
	});
	logActivity({ action: 'auth.recovery.start', userId: user.id, organizerId: user.organizerId });
	return res.json({ message: 'Enlace enviado al correo registrado', token });
});

app.post('/auth/recovery/complete', (req, res) => {
	const { token, newPassword } = req.body || {};
	if (!token || !newPassword) return res.status(400).json({ error: 'Token y nueva contraseña requeridos' });
	if (String(newPassword).length < 8) return res.status(400).json({ error: 'Password muy corto (min 8)' });
	const entry = db.recoveryTokens.get(token);
	if (!entry) return res.status(400).json({ error: 'Token invalido' });
	if (entry.expiresAt < Date.now()) {
		db.recoveryTokens.delete(token);
		return res.status(400).json({ error: 'Token expirado' });
	}
	const user = db.users.find((u) => u.id === entry.userId);
	if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
	user.password = bcrypt.hashSync(String(newPassword), 12);
	markUserVerified(user);
	// Revocar refresh tokens del usuario
	Array.from(db.refreshTokens.entries())
		.filter(([, uid]) => uid === user.id)
		.forEach(([tkn]) => db.refreshTokens.delete(tkn));
	db.recoveryTokens.delete(token);
	logActivity({ action: 'auth.recovery.complete', userId: user.id, organizerId: user.organizerId });
	return res.json({ message: 'Contraseña actualizada. Inicia sesión nuevamente.' });
});

// Solicitar reset por correo (cualquier rol)
app.post('/auth/password/reset/request', limitSensitive, (req, res) => {
	const { email } = req.body || {};
	if (!validateEmail(email)) return res.status(400).json({ error: 'Email invalido' });
	const user = db.users.find((u) => u.email === email);
	if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
	const token = uuid();
	const expiresAt = Date.now() + 30 * 60 * 1000;
	db.passwordResetTokens.set(token, { userId: user.id, expiresAt });
	const link = `${process.env.APP_URL || 'https://rifas.local'}/reset?token=${token}`;
	sendEmail({
		to: user.email,
		subject: 'Recupera tu contraseña',
		html: `<p>Usa este enlace por 30 minutos:</p><p><a href="${link}">${link}</a></p>`
	});
	logActivity({ action: 'auth.reset.request', userId: user.id, organizerId: user.organizerId });
	return res.json({ message: 'Enlace enviado al correo registrado' });
});

app.post('/auth/password/reset/complete', limitSensitive, (req, res) => {
	const { token, newPassword } = req.body || {};
	if (!token || !newPassword) return res.status(400).json({ error: 'Token y nueva contraseña requeridos' });
	if (String(newPassword).length < 8) return res.status(400).json({ error: 'Password muy corto (min 8)' });
	const entry = db.passwordResetTokens.get(String(token));
	if (!entry) return res.status(400).json({ error: 'Token invalido' });
	if (entry.expiresAt < Date.now()) {
		db.passwordResetTokens.delete(String(token));
		return res.status(400).json({ error: 'Token expirado' });
	}
	const user = db.users.find((u) => u.id === entry.userId);
	if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
	user.password = bcrypt.hashSync(String(newPassword), 12);
	markUserVerified(user);
	Array.from(db.refreshTokens.entries())
		.filter(([, uid]) => uid === user.id)
		.forEach(([tkn]) => db.refreshTokens.delete(tkn));
	db.passwordResetTokens.delete(String(token));
	logActivity({ action: 'auth.reset.complete', userId: user.id, organizerId: user.organizerId });
	return res.json({ message: 'Contraseña actualizada. Inicia sesión nuevamente.' });
});

// Verificación de correo
const handleVerification = ({ email, code }) => {
	const normalizedEmail = String(email || '').trim().toLowerCase();
	const normalizedCode = String(code || '').trim();
	if (!normalizedEmail) return { error: 'Email requerido', status: 400 };
	if (!validateEmail(normalizedEmail)) return { error: 'Email invalido', status: 400 };
	if (!normalizedCode) return { error: 'Código requerido', status: 400 };
	const entry = db.verificationTokens.get(normalizedCode);
	if (!entry) {
		logActivity({ action: 'auth.verify.failed', userId: null, organizerId: null, meta: { email: normalizedEmail, reason: 'code_not_found' } });
		return { error: 'Código inválido', status: 400 };
	}
	if (entry.expiresAt < Date.now()) {
		db.verificationTokens.delete(normalizedCode);
		logActivity({ action: 'auth.verify.failed', userId: entry.userId, organizerId: null, meta: { email: normalizedEmail, reason: 'code_expired' } });
		return { error: 'Código expirado', status: 400 };
	}
	const user = db.users.find((u) => u.id === entry.userId);
	if (!user) return { error: 'Usuario no encontrado', status: 404 };
	if (user.email?.toLowerCase() !== normalizedEmail) {
		logActivity({ action: 'auth.verify.failed', userId: user.id, organizerId: user.organizerId, meta: { email: normalizedEmail, reason: 'email_mismatch' } });
		return { error: 'Código inválido para este usuario', status: 400 };
	}
	markUserVerified(user);
	Array.from(db.refreshTokens.entries())
		.filter(([, uid]) => uid === user.id)
		.forEach(([tkn]) => db.refreshTokens.delete(tkn));
	db.verificationTokens.delete(normalizedCode);
	logActivity({ action: 'auth.verify.email', userId: user.id, organizerId: user.organizerId, meta: { email: normalizedEmail, code: normalizedCode } });
	return { message: 'Tu cuenta ha sido activada correctamente' };
};

app.post('/auth/verify', (req, res) => {
	const { code, email } = req.body || {};
	const result = handleVerification({ code, email });
	if (result?.error) return res.status(result.status || 400).json({ error: result.error });
	return res.json({ message: result.message });
});

app.get('/auth/verify', (req, res) => {
	const { code, token, email } = req.query || {};
	const result = handleVerification({ code: code || token, email });
	if (result?.error) return res.status(result.status || 400).json({ error: result.error });
	return res.json({ message: result.message });
});

app.get('/verify', (req, res) => {
	const { code, token, email } = req.query || {};
	const result = handleVerification({ code: code || token, email });
	if (result?.error) return res.status(result.status || 400).json({ error: result.error });
	return res.json({ message: result.message });
});

app.post('/auth/verify/resend', async (req, res) => {
	const { email } = req.body || {};
	if (!validateEmail(email)) return res.status(400).json({ error: 'Email invalido' });
	const user = db.users.find((u) => u.email === email);
	if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
	if (user.isVerified || user.verified) return res.json({ message: 'La cuenta ya está verificada' });

	clearUserVerificationTokens(user.id);
	let code = generateVerificationCode();
	while (db.verificationTokens.has(code)) {
		code = generateVerificationCode();
	}
	const expiresAt = Date.now() + VERIFICATION_TOKEN_TTL_MS;
	db.verificationTokens.set(code, { userId: user.id, expiresAt });
	await sendEmail({
		to: email,
		subject: 'Tu código de verificación',
		html: `<p>Tu código de verificación es:</p><p style="font-size:20px;font-weight:bold;letter-spacing:2px;">${code}</p><p>Ingresa este código en la app para activar tu cuenta (24h).</p><p>Si no solicitaste este código, ignora este mensaje.</p>`
	});
	logActivity({ action: 'auth.verify.resend', userId: user.id, organizerId: user.organizerId, meta: { code, expiresAt } });
	return res.json({ message: 'Código reenviado. Revisa tu correo.' });
});

app.post('/auth/refresh', limitSensitive, (req, res) => {
	const { refreshToken } = req.body || {};
	if (!refreshToken) return res.status(400).json({ error: 'Refresh token requerido' });
	try {
		const payload = jwt.verify(refreshToken, JWT_SECRET);
		if (payload.type !== 'refresh') return res.status(401).json({ error: 'Token invalido' });
		const storedUserId = db.refreshTokens.get(refreshToken);
		if (!storedUserId) {
			revokeUserRefreshTokens(payload.id);
			logActivity({ action: 'auth.refresh.reuse_detected', userId: payload.id, organizerId: null, meta: { token: 'revoked' } });
			return res.status(401).json({ error: 'Refresh token reutilizado o revocado' });
		}
		if (storedUserId !== payload.id) return res.status(401).json({ error: 'Refresh token no válido' });
		const record = db.users.find((u) => u.id === payload.id);
		if (!record) return res.status(401).json({ error: 'Usuario no encontrado' });
		if (record.active === false) return res.status(403).json({ error: 'Cuenta desactivada por administrador' });
		db.refreshTokens.delete(refreshToken); // rotación
		const maybeCode = ensureAdminSecurityCode(record);
		const user = {
			id: record.id,
			email: record.email,
			role: record.role || 'user',
			firstName: record.firstName,
			lastName: record.lastName,
			address: record.address,
			dob: record.dob,
			cedula: record.cedula,
			phone: record.phone,
			organizerId: record.organizerId,
			support: record.support || {}
		};
		const tokens = issueTokens(user);
		return res.json({ ...tokens, user, securityCode: maybeCode });
	} catch (_err) {
		return res.status(401).json({ error: 'Refresh token invalido' });
	}
});

app.post('/auth/logout', authMiddleware, (req, res) => {
	const { refreshToken } = req.body || {};
	if (refreshToken) db.refreshTokens.delete(refreshToken);
	revokeUserRefreshTokens(req.user.id);
	logActivity({ action: 'auth.logout', userId: req.user.id, organizerId: req.user.organizerId });
	return res.json({ message: 'Sesión cerrada' });
});

app.post('/auth/2fa/verify', limitSensitive, (req, res) => {
	const { userId, code } = req.body || {};
	if (!userId || !code) return res.status(400).json({ error: 'userId y código requeridos' });
	const pending = db.twoFactor.get(userId);
	if (!pending) return res.status(400).json({ error: 'No hay 2FA pendiente' });
	if (pending.expiresAt < Date.now()) {
		db.twoFactor.delete(userId);
		return res.status(400).json({ error: 'Código expirado' });
	}
	if (pending.code !== String(code).trim()) return res.status(400).json({ error: 'Código incorrecto' });
	const record = db.users.find((u) => u.id === userId);
	if (!record) return res.status(404).json({ error: 'Usuario no encontrado' });
	if (record.active === false) return res.status(403).json({ error: 'Cuenta desactivada por administrador' });
	db.twoFactor.delete(userId);
	const maybeCode = ensureAdminSecurityCode(record);
	const user = {
		id: record.id,
		email: record.email,
		role: record.role || 'user',
		firstName: record.firstName,
		lastName: record.lastName,
		address: record.address,
		dob: record.dob,
		cedula: record.cedula,
		phone: record.phone,
		organizerId: record.organizerId,
		support: record.support || {}
	};
	const tokens = issueTokens(user);
	logActivity({ action: 'auth.2fa.verified', userId: user.id, organizerId: record.organizerId });
	return res.json({ ...tokens, user, securityCode: maybeCode });
});

app.get('/wallet', authMiddleware, (req, res) => {
	const wallet = db.wallets[req.user.id] || { balance: 0 };
	return res.json(wallet);
});

app.get('/me', authMiddleware, (req, res) => {
	const user = db.users.find((u) => u.id === req.user.id);
	if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
	const { password, ...safe } = user;
	return res.json(safe);
});

app.post('/me/push-token', authMiddleware, (req, res) => {
	const user = db.users.find((u) => u.id === req.user.id);
	if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
	const token = String(req.body?.token || '').trim();
	if (!token || token.length > 256) return res.status(400).json({ error: 'Token push inválido' });
	user.pushTokens = Array.isArray(user.pushTokens) ? user.pushTokens : [];
	if (!user.pushTokens.includes(token)) user.pushTokens.push(token);
	logActivity({ action: 'user.pushToken.save', userId: user.id, organizerId: user.organizerId, meta: { count: user.pushTokens.length } });
	return res.json({ message: 'Token guardado' });
});

// Superadmin: gestión de usuarios (activar/desactivar, verificar, rol).
app.patch('/superadmin/users/:id/status', authMiddleware, superadminMiddleware, (req, res) => {
	const user = db.users.find((u) => u.id === req.params.id);
	if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
	const { active, verified, isVerified, role } = req.body || {};
	if (active !== undefined) user.active = !!active;
	if (verified !== undefined) user.verified = !!verified;
	if (isVerified !== undefined) user.isVerified = !!isVerified;
	if (role && ['user', 'admin', 'organizer', 'superadmin'].includes(role)) user.role = role;
	logActivity({ action: 'superadmin.user.status', userId: req.user.id, organizerId: req.user.organizerId, meta: { target: user.id, active: user.active, verified: user.verified, isVerified: user.isVerified, role: user.role } });
	const { password, ...safe } = user;
	return res.json({ message: 'Estado actualizado', user: safe });
});

app.post('/superadmin/users/:id/reset-2fa', authMiddleware, superadminMiddleware, (req, res) => {
	const user = db.users.find((u) => u.id === req.params.id);
	if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
	db.twoFactor.delete(user.id);
	logActivity({ action: 'superadmin.user.reset2fa', userId: req.user.id, organizerId: req.user.organizerId, meta: { target: user.id } });
	return res.json({ message: '2FA reiniciado' });
});

app.post('/superadmin/users/:id/revoke-sessions', authMiddleware, superadminMiddleware, (req, res) => {
	const user = db.users.find((u) => u.id === req.params.id);
	if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
	Array.from(db.refreshTokens.entries())
		.filter(([, uid]) => uid === user.id)
		.forEach(([tkn]) => db.refreshTokens.delete(tkn));
	logActivity({ action: 'superadmin.user.revokeSessions', userId: req.user.id, organizerId: req.user.organizerId, meta: { target: user.id } });
	return res.json({ message: 'Sesiones revocadas' });
});

app.get('/superadmin/settings', authMiddleware, superadminMiddleware, (_req, res) => {
	return res.json({ branding: platformSettings.branding, modules: platformSettings.modules });
});

app.patch('/superadmin/settings/branding', authMiddleware, superadminMiddleware, (req, res) => {
	const { title, tagline, primaryColor, secondaryColor, logoUrl, bannerUrl, policies } = req.body || {};
	const branding = platformSettings.branding;
	if (title !== undefined) branding.title = String(title).trim();
	if (tagline !== undefined) branding.tagline = String(tagline).trim();
	if (primaryColor !== undefined) branding.primaryColor = String(primaryColor).trim();
	if (secondaryColor !== undefined) branding.secondaryColor = String(secondaryColor).trim();
	if (logoUrl !== undefined) branding.logoUrl = String(logoUrl).trim();
	if (bannerUrl !== undefined) branding.bannerUrl = String(bannerUrl).trim();
	if (policies !== undefined) branding.policies = String(policies).trim();
	logActivity({ action: 'superadmin.branding.update', userId: req.user.id, organizerId: req.user.organizerId, meta: branding });
	return res.json({ branding });
});

app.patch('/superadmin/settings/modules', authMiddleware, superadminMiddleware, (req, res) => {
	const { modules } = req.body || {};
	if (!modules || typeof modules !== 'object') return res.status(400).json({ error: 'Módulos inválidos' });
	['user', 'admin', 'superadmin'].forEach((role) => {
		if (modules[role] && typeof modules[role] === 'object') {
			platformSettings.modules[role] = { ...platformSettings.modules[role], ...modules[role] };
		}
	});
	logActivity({ action: 'superadmin.modules.update', userId: req.user.id, organizerId: req.user.organizerId, meta: platformSettings.modules });
	return res.json({ modules: platformSettings.modules });
});

app.get('/superadmin/audit/users', authMiddleware, superadminMiddleware, (_req, res) => {
	const rows = db.users.map((u) => {
		const lastLog = [...db.activityLogs].reverse().find((l) => l.userId === u.id);
		const { password, ...safe } = u;
		return { ...safe, lastActivity: lastLog?.createdAt || null };
	});
	return res.json(rows);
});

app.get('/superadmin/mail/logs', authMiddleware, superadminMiddleware, (_req, res) => {
	return res.json(db.mailLogs.slice(-200));
});

app.get('/modules', authMiddleware, (_req, res) => {
	return res.json(platformSettings.modules);
});

app.post('/superadmin/users', authMiddleware, superadminMiddleware, (req, res) => {
	const { email, password, firstName = '', lastName = '', role = 'user', active = true } = req.body || {};
	const normalizedEmail = String(email || '').trim().toLowerCase();
	if (!validateEmail(normalizedEmail)) return res.status(400).json({ error: 'Email invalido' });
	if (!password || String(password).length < 8) return res.status(400).json({ error: 'Password muy corto (min 8)' });
	if (!['user', 'admin'].includes(role)) return res.status(400).json({ error: 'Rol invalido' });
	if (db.users.some((u) => u.email?.toLowerCase() === normalizedEmail)) return res.status(409).json({ error: 'El email ya existe' });

	const hashed = bcrypt.hashSync(password, 12);
	const newUser = {
		id: uuid(),
		email: normalizedEmail,
		password: hashed,
		role,
		verified: true,
		isVerified: true,
		active: !!active,
		organizerId: generateOrganizerId(),
		firstName: String(firstName || '').trim(),
		lastName: String(lastName || '').trim(),
		createdAt: Date.now(),
		support: {}
	};
	if (role === 'admin') {
		const code = generateSecurityCode();
		newUser.securityCodeHash = bcrypt.hashSync(code, 10);
		newUser.securityCodeUpdatedAt = Date.now();
		sendEmail({ to: normalizedEmail, subject: 'Tu cuenta admin', html: `<p>Bienvenido. Tu código de seguridad: <strong>${code}</strong></p>` });
	}
	db.users.push(newUser);
	db.wallets[newUser.id] = { balance: 0 };
	logActivity({ action: 'superadmin.user.create', userId: req.user.id, organizerId: req.user.organizerId, meta: { target: newUser.id, role: newUser.role } });
	const { password: _pw, ...safe } = newUser;
	return res.status(201).json({ message: 'Cuenta creada', user: safe });
});

// Superadmin: eliminar todas las cuentas excepto el superadmin y revocar sesiones
app.delete('/superadmin/users/purge', authMiddleware, superadminMiddleware, (_req, res) => {
	const survivors = [];
	const removedIds = [];
	for (const user of db.users) {
		if (user.email?.toLowerCase() === SUPERADMIN_EMAIL && user.role === 'superadmin') {
			survivors.push(user);
			continue;
		}
		removedIds.push(user.id);
	}
	db.users = survivors;
	removedIds.forEach((id) => {
		db.wallets[id] = undefined;
		db.twoFactor.delete(id);
	});
	Array.from(db.refreshTokens.entries())
		.filter(([, uid]) => removedIds.includes(uid))
		.forEach(([tkn]) => db.refreshTokens.delete(tkn));
	logActivity({ action: 'superadmin.users.purge', userId: _req.user.id, organizerId: _req.user.organizerId, meta: { removed: removedIds.length } });
	return res.json({ message: 'Usuarios eliminados', removed: removedIds.length });
});

// Superadmin: regenerar código de seguridad para cualquier usuario admin/organizer.
app.post('/superadmin/users/:id/security-code/regenerate', authMiddleware, superadminMiddleware, (req, res) => {
	const user = db.users.find((u) => u.id === req.params.id);
	if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
	const code = generateSecurityCode();
	user.securityCodeHash = bcrypt.hashSync(code, 10);
	user.securityCodeUpdatedAt = Date.now();
	sendEmail({
		to: user.email,
		subject: 'Nuevo código de seguridad',
		html: `<p>Tu código fue regenerado por el superadmin.</p><p><strong>${code}</strong></p>`
	});
	logActivity({ action: 'superadmin.securityCode.regenerate', userId: req.user.id, organizerId: req.user.organizerId, meta: { target: user.id } });
	return res.json({ message: 'Código regenerado', code });
});

app.put('/me', authMiddleware, (req, res) => {
	const user = db.users.find((u) => u.id === req.user.id);
	if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
	const { phone, address, avatar, support, bio, socials } = req.body || {};
	
	if (phone && !validatePhone(phone)) return res.status(400).json({ error: 'Telefono invalido' });
	if (address && String(address).trim().length < 3) return res.status(400).json({ error: 'Direccion invalida' });
	if (support?.email && !validateEmail(support.email)) return res.status(400).json({ error: 'Email de soporte invalido' });

	if (phone) user.phone = String(phone).trim();
	if (address) user.address = String(address).trim();
	if (avatar) user.avatar = String(avatar);
	if (bio) user.bio = String(bio).trim();

	// Handle both 'support' (legacy/backend) and 'socials' (frontend)
	const incomingSocials = socials || support;
	if (incomingSocials && typeof incomingSocials === 'object') {
		const cleanSupport = {};
		['whatsapp', 'instagram', 'facebook', 'tiktok', 'website', 'email'].forEach((field) => {
			if (incomingSocials[field] !== undefined) cleanSupport[field] = String(incomingSocials[field]).trim();
		});
		user.support = { ...(user.support || {}), ...cleanSupport };
		// Also sync to socials for frontend compatibility if needed, but frontend seems to read 'socials' from profile which might be 'support' in DB?
		// Let's ensure the response includes 'socials' mapped from 'support'
		user.socials = user.support; 
	}

	logActivity({
		action: 'user.updateProfile',
		userId: user.id,
		organizerId: user.organizerId,
		meta: { phone: !!phone, address: !!address, avatar: !!avatar, support: !!user.support, bio: !!bio }
	});
	const { password, ...safe } = user;
	return res.json(safe);
});

app.post('/wallet/deposit', authMiddleware, (req, res) => {
	const amount = Number(req.body?.amount);
	if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Monto invalido' });
	const wallet = db.wallets[req.user.id] || { balance: 0 };
	wallet.balance += amount;
	db.wallets[req.user.id] = wallet;
	return res.json(wallet);
});

app.get('/raffles', authMiddleware, (_req, res) => {
	return res.json(
		db.raffles.map((raffle) => {
			const stats = getRaffleProgress(raffle);
			const creator = db.users.find((u) => u.id === raffle.creatorId);
			return { ...raffle, stats, support: creator?.support || {} };
		})
	);
});

// Admin: gestionar rifas y ver estadísticas rápidas.
app.get('/admin/raffles', authMiddleware, adminMiddleware, (_req, res) => {
	return res.json(
		db.raffles.map((raffle) => {
			const stats = getRaffleProgress(raffle);
			const creator = db.users.find((u) => u.id === raffle.creatorId);
			return { ...raffle, stats, support: creator?.support || {} };
		})
	);
});

app.post('/raffles', authMiddleware, (req, res) => {
	const { title, price, description = '', startDate, endDate, totalTickets, securityCode } = req.body || {};
	const normalizedPrice = Number(price);
	if (!title || !Number.isFinite(normalizedPrice) || normalizedPrice <= 0) {
		return res.status(400).json({ error: 'Titulo y precio valido son requeridos' });
	}
	if (startDate && !isIsoDate(startDate)) return res.status(400).json({ error: 'Fecha de inicio invalida' });
	if (endDate && !isIsoDate(endDate)) return res.status(400).json({ error: 'Fecha de cierre invalida' });
	const capacity = Number(totalTickets);
	if (totalTickets && (!Number.isFinite(capacity) || capacity <= 0)) return res.status(400).json({ error: 'Total de tickets invalido' });
	const creator = db.users.find((u) => u.id === req.user.id);
	if ((req.user.role === 'admin' || req.user.role === 'organizer') && !isSuperAdmin(req.user)) {
		if (!securityCode) return res.status(401).json({ error: 'Código de seguridad requerido' });
		if (!creator?.securityCodeHash || !bcrypt.compareSync(String(securityCode), creator.securityCodeHash))
			return res.status(401).json({ error: 'Código de seguridad incorrecto' });
	}
	const normalizedCapacity = totalTickets ? Math.min(capacity, MAX_TICKETS) : MAX_TICKETS;
	const startIso = startDate ? new Date(startDate).toISOString() : new Date().toISOString();
	const endIso = endDate ? new Date(endDate).toISOString() : null;

	const raffle = {
		id: uuid(),
		title: String(title).trim(),
		price: normalizedPrice,
		description: String(description || ''),
		creatorId: req.user.id,
		organizerId: creator?.organizerId,
		status: 'active',
		winningTicketNumber: null,
		nextTicket: 1,
		createdAt: Date.now(),
		startDate: startIso,
		endDate: endIso,
		totalTickets: normalizedCapacity,
		style: {
			bannerImage: '',
			themeColor: '#2563eb',
			accentColor: '#10b981',
			headline: '',
			ctaText: ''
		}
	};

	db.raffles.push(raffle);
	logActivity({ action: 'raffle.create', userId: req.user.id, organizerId: creator?.organizerId, meta: { raffleId: raffle.id, title: raffle.title } });
	return res.status(201).json(raffle);
});

app.get('/raffles/:id/tickets', (req, res) => {
	const raffle = db.raffles.find((r) => r.id === req.params.id);
	if (!raffle) return res.status(404).json({ error: 'Rifa no encontrada' });
	const assigned = Array.from(getAssignedNumbers(raffle.id));
	return res.json({ taken: assigned, total: getRaffleCapacity(raffle) });
});

app.post('/raffles/:id/purchase', authMiddleware, (req, res) => {
	const raffle = db.raffles.find((r) => r.id === req.params.id);
	if (!raffle) return res.status(404).json({ error: 'Rifa no encontrada' });
	if (raffle.status !== 'active') return res.status(400).json({ error: 'La rifa ya no esta activa' });
	const organizer = db.users.find((u) => u.id === raffle.creatorId);

	const quantity = sanitizeNumber(req.body?.quantity || 0);
	const selectedNumbers = Array.isArray(req.body?.selectedNumbers) ? req.body.selectedNumbers.map(Number) : [];

	if (selectedNumbers.length > 0) {
		if (selectedNumbers.length !== quantity) return res.status(400).json({ error: 'La cantidad no coincide con los números seleccionados' });
		
		const assigned = getAssignedNumbers(raffle.id);
		const capacity = getRaffleCapacity(raffle);
		
		for (const num of selectedNumbers) {
			if (!Number.isFinite(num) || num < 1 || num > capacity) return res.status(400).json({ error: `Número inválido: ${num}` });
			if (assigned.has(num)) return res.status(400).json({ error: `El número ${num} ya está ocupado` });
		}
	} else {
		if (!Number.isFinite(quantity) || quantity <= 0) return res.status(400).json({ error: 'Cantidad invalida' });
	}

	let numbers;
	if (selectedNumbers.length > 0) {
		numbers = selectedNumbers.sort((a, b) => a - b);
	} else {
		numbers = allocateRandomNumbers(raffle, quantity);
		if (!numbers) return res.status(400).json({ error: 'No hay suficientes numeros disponibles' });
	}
	
	const formattedNumbers = numbers.map(formatTicketNumber);

	const wallet = db.wallets[req.user.id] || { balance: 0 };
	const total = raffle.price * quantity;
	if (wallet.balance < total) return res.status(400).json({ error: 'Fondos insuficientes en wallet' });

	wallet.balance -= total;
	db.wallets[req.user.id] = wallet;

	const userRecord = db.users.find((u) => u.id === req.user.id);

	const purchase = {
		id: uuid(),
		raffleId: raffle.id,
		userId: req.user.id,
		numbers: formattedNumbers,
		amount: total,
		buyer: snapshotBuyer(userRecord),
		status: 'approved',
		createdAt: Date.now(),
		via: 'wallet'
	};
	db.purchases.push(purchase);
	const soldCount = getAssignedNumbers(raffle.id).size;
	raffle.nextTicket = soldCount + 1;
	sendTicketConfirmationEmail({ buyer: userRecord, raffle, numbers: formattedNumbers, organizer, purchaseDate: purchase.createdAt });
	logActivity({ action: 'raffle.purchase', userId: req.user.id, organizerId: userRecord?.organizerId, meta: { raffleId: raffle.id, quantity, numbers: formattedNumbers } });

	return res.status(201).json({ raffleId: raffle.id, numbers: formattedNumbers, remainingBalance: wallet.balance });
});

// Admin: editar campos principales de una rifa (titulo, precio, fechas, capacidad, estado).
app.patch('/admin/raffles/:id', authMiddleware, adminMiddleware, (req, res) => {
	const raffle = db.raffles.find((r) => r.id === req.params.id);
	if (!raffle) return res.status(404).json({ error: 'Rifa no encontrada' });

	const { title, price, description, status, startDate, endDate, totalTickets } = req.body || {};
	const updates = {};

	if (title !== undefined) updates.title = String(title).trim();
	if (description !== undefined) updates.description = String(description || '');
	if (price !== undefined) {
		const normalizedPrice = Number(price);
		if (!Number.isFinite(normalizedPrice) || normalizedPrice <= 0) return res.status(400).json({ error: 'Precio invalido' });
		updates.price = normalizedPrice;
	}
	if (startDate !== undefined) {
		if (startDate && !isIsoDate(startDate)) return res.status(400).json({ error: 'Fecha de inicio invalida' });
		updates.startDate = startDate ? new Date(startDate).toISOString() : null;
	}
	if (endDate !== undefined) {
		if (endDate && !isIsoDate(endDate)) return res.status(400).json({ error: 'Fecha de cierre invalida' });
		updates.endDate = endDate ? new Date(endDate).toISOString() : null;
	}
	if (totalTickets !== undefined) {
		const capacity = Number(totalTickets);
		const currentStats = getRaffleProgress(raffle);
		if (!Number.isFinite(capacity) || capacity <= 0) return res.status(400).json({ error: 'Total de tickets invalido' });
		const normalizedCap = Math.min(capacity, MAX_TICKETS);
		if (normalizedCap < currentStats.sold)
			return res.status(400).json({ error: 'No puedes poner menos tickets de los ya vendidos' });
		updates.totalTickets = normalizedCap;
	}
	if (status !== undefined) {
		const allowed = ['active', 'paused', 'closed'];
		if (!allowed.includes(status)) return res.status(400).json({ error: 'Estado invalido' });
		updates.status = status;
	}

	Object.assign(raffle, updates);
	const adminActor = db.users.find((u) => u.id === req.user.id);
	logActivity({ action: 'raffle.update', userId: req.user.id, organizerId: adminActor?.organizerId, meta: { raffleId: raffle.id, updates: Object.keys(updates) } });
	return res.json({ message: 'Rifa actualizada', raffle: { ...raffle, stats: getRaffleProgress(raffle) } });
});

// Superadmin/admin: eliminar rifa.
app.delete('/admin/raffles/:id', authMiddleware, adminMiddleware, (req, res) => {
	const index = db.raffles.findIndex((r) => r.id === req.params.id);
	if (index === -1) return res.status(404).json({ error: 'Rifa no encontrada' });
	const raffle = db.raffles[index];
	if (!isSuperAdmin(req.user) && raffle.creatorId !== req.user.id) return res.status(403).json({ error: 'Solo superadmin o creador pueden eliminar' });
	db.raffles.splice(index, 1);
	// Limpia compras y pagos asociados
	db.purchases = db.purchases.filter((p) => p.raffleId !== raffle.id);
	db.manualPayments = db.manualPayments.filter((m) => m.raffleId !== raffle.id);
	logActivity({ action: 'raffle.delete', userId: req.user.id, organizerId: req.user.organizerId, meta: { raffleId: raffle.id } });
	return res.json({ message: 'Rifa eliminada' });
});

// Pago manual: guarda comprobante y queda pendiente hasta ser aprobado por admin.
app.post('/raffles/:id/manual-payments', authMiddleware, (req, res) => {
	const raffle = db.raffles.find((r) => r.id === req.params.id);
	if (!raffle) return res.status(404).json({ error: 'Rifa no encontrada' });
	if (raffle.status !== 'active') return res.status(400).json({ error: 'La rifa ya no esta activa' });

	const quantity = sanitizeNumber(req.body?.quantity || 0);
	const capacity = getRaffleCapacity(raffle);
	if (!Number.isFinite(quantity) || quantity <= 0) return res.status(400).json({ error: 'Cantidad invalida' });
	if (raffle.nextTicket + quantity - 1 > capacity)
		return res.status(400).json({ error: 'No hay suficientes numeros disponibles' });

	const proof = req.body?.proof || '';
	const reference = req.body?.reference || '';
	const note = req.body?.note || '';

	const payment = {
		id: uuid(),
		raffleId: raffle.id,
		userId: req.user.id,
		quantity,
		status: 'pending',
		proof,
		reference,
			note,
			createdAt: Date.now()
	};
	db.manualPayments.push(payment);
	const actor = db.users.find((u) => u.id === req.user.id);
	logActivity({ action: 'manualPayment.submit', userId: req.user.id, organizerId: actor?.organizerId, meta: { raffleId: raffle.id } });

	return res.status(201).json({ message: 'Pago enviado y pendiente de verificacion', payment });
});

app.post('/raffles/:id/close', authMiddleware, (req, res) => {
	const raffle = db.raffles.find((r) => r.id === req.params.id);
	if (!raffle) return res.status(404).json({ error: 'Rifa no encontrada' });
	if (raffle.creatorId !== req.user.id && req.user.role !== 'admin')
		return res.status(403).json({ error: 'Solo el creador o un admin pueden cerrar la rifa' });
	if (raffle.status !== 'active') return res.status(400).json({ error: 'La rifa ya esta cerrada' });

	const tickets = db.purchases
		.filter((p) => p.raffleId === raffle.id)
		.flatMap((p) => p.numbers.map((number) => ({ number, userId: p.userId })));

	if (!tickets.length) return res.status(400).json({ error: 'No hay participantes aun' });

	const winnerTicket = tickets[Math.floor(Math.random() * tickets.length)];
	raffle.status = 'closed';
	raffle.winningTicketNumber = winnerTicket.number;
	const closer = db.users.find((u) => u.id === req.user.id);
	logActivity({ action: 'raffle.close', userId: req.user.id, organizerId: closer?.organizerId, meta: { raffleId: raffle.id, winningTicket: winnerTicket.number } });

	return res.json({ raffleId: raffle.id, winner: winnerTicket });
});

// Admin o creador puede modificar estilo/imagenes promo de la rifa.
app.patch('/raffles/:id/style', authMiddleware, (req, res) => {
	const raffle = db.raffles.find((r) => r.id === req.params.id);
	if (!raffle) return res.status(404).json({ error: 'Rifa no encontrada' });
	if (raffle.creatorId !== req.user.id && req.user.role !== 'admin')
		return res.status(403).json({ error: 'No autorizado para editar estilo' });

	const { bannerImage, themeColor, accentColor, headline, ctaText } = req.body || {};
	raffle.style = {
		bannerImage: bannerImage ?? raffle.style?.bannerImage ?? '',
		themeColor: themeColor ?? raffle.style?.themeColor ?? '#2563eb',
		accentColor: accentColor ?? raffle.style?.accentColor ?? '#10b981',
		headline: headline ?? raffle.style?.headline ?? '',
		ctaText: ctaText ?? raffle.style?.ctaText ?? ''
	};
	const actor = db.users.find((u) => u.id === req.user.id);
	logActivity({ action: 'raffle.style.update', userId: req.user.id, organizerId: actor?.organizerId, meta: { raffleId: raffle.id } });

	return res.json({ message: 'Estilo actualizado', style: raffle.style });
});

// Admin: listar pagos manuales pendientes/aprobados.
app.get('/admin/manual-payments', authMiddleware, adminMiddleware, (_req, res) => {
	return res.json(db.manualPayments);
});

// Admin: estado de código de seguridad.
app.get('/admin/security-code', authMiddleware, adminMiddleware, (req, res) => {
	const user = db.users.find((u) => u.id === req.user.id);
	if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
	return res.json({ active: !!user.securityCodeHash, updatedAt: user.securityCodeUpdatedAt || null });
});

// Admin: regenerar código de seguridad.
app.post('/admin/security-code/regenerate', authMiddleware, adminMiddleware, (_req, res) => {
	const user = db.users.find((u) => u.id === req.user.id);
	if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
	const code = generateSecurityCode();
	user.securityCodeHash = bcrypt.hashSync(code, 10);
	user.securityCodeUpdatedAt = Date.now();
	sendEmail({
		to: user.email,
		subject: 'Nuevo código de seguridad',
		html: `<p>Tu código se regeneró. Código nuevo: <strong>${code}</strong>. Guarda este valor y no lo compartas.</p>`
	});
	logActivity({ action: 'admin.securityCode.regenerate', userId: user.id, organizerId: user.organizerId });
	return res.json({ message: 'Código regenerado', code });
});

// Superadmin: configuración global (branding y correo).
app.get('/superadmin/settings', authMiddleware, superadminMiddleware, (_req, res) => {
	return res.json(platformSettings);
});

app.patch('/superadmin/settings', authMiddleware, superadminMiddleware, (req, res) => {
	const { email, branding } = req.body || {};
	if (email) {
		if (email.domain) {
			platformSettings.email.domain = String(email.domain).trim();
			if (!email.from) platformSettings.email.from = `rifa@${platformSettings.email.domain}`;
		}
		if (email.from) platformSettings.email.from = String(email.from).trim();
	}
	if (branding) {
		['logoUrl', 'bannerUrl', 'primaryColor', 'secondaryColor', 'tagline', 'policies'].forEach((key) => {
			if (branding[key] !== undefined) platformSettings.branding[key] = String(branding[key]);
		});
	}
	logActivity({ action: 'superadmin.settings.update', userId: req.user.id, organizerId: req.user.organizerId, meta: { email: !!email, branding: !!branding } });
	return res.json({ message: 'Configuración actualizada', settings: platformSettings });
});

// Superadmin: estadísticas globales.
app.get('/superadmin/stats', authMiddleware, superadminMiddleware, (_req, res) => {
	const totalUsers = db.users.length;
	const totalAdmins = db.users.filter((u) => u.role === 'admin').length;
	const totalRaffles = db.raffles.length;
	const totalPurchases = db.purchases.length;
	const totalSales = db.purchases.reduce((sum, p) => sum + (p.amount || 0), 0);
	const ticketsSold = db.purchases.reduce((sum, p) => sum + (p.numbers?.length || 0), 0);
	return res.json({ totalUsers, totalAdmins, totalRaffles, totalPurchases, totalSales, ticketsSold });
});

// Superadmin: limpiar usuarios/admins dejando solo superadmin.
app.post('/superadmin/reset-users', authMiddleware, superadminMiddleware, (_req, res) => {
	const superadmins = db.users.filter((u) => u.role === 'superadmin');
	const superadminIds = new Set(superadmins.map((u) => u.id));
	const removedUsers = db.users.filter((u) => u.role !== 'superadmin').map((u) => u.id);
	db.users = superadmins;
	// Limpia wallets, tokens y estados vinculados a usuarios removidos
	db.wallets = Object.fromEntries(Object.entries(db.wallets).filter(([uid]) => superadminIds.has(uid)));
	db.loginAttempts = new Map();
	db.twoFactor = new Map();
	db.recoveryTokens = new Map();
	db.refreshTokens = new Map();
	// Limpia compras/pagos/raffles de usuarios removidos
	db.purchases = db.purchases.filter((p) => superadminIds.has(p.userId));
	db.manualPayments = db.manualPayments.filter((m) => superadminIds.has(m.userId));
	const rafflesOwnedBySuper = new Set(db.raffles.filter((r) => superadminIds.has(r.creatorId)).map((r) => r.id));
	db.raffles = db.raffles.filter((r) => superadminIds.has(r.creatorId));
	// Filtra cualquier purchase/payment ligado a rifas eliminadas
	db.purchases = db.purchases.filter((p) => rafflesOwnedBySuper.has(p.raffleId));
	db.manualPayments = db.manualPayments.filter((m) => rafflesOwnedBySuper.has(m.raffleId));
	logActivity({ action: 'superadmin.resetUsers', userId: Array.from(superadminIds)[0], organizerId: 'SUPERADMIN', meta: { removedUsers: removedUsers.length } });
	return res.json({ message: 'Usuarios y administradores eliminados, solo superadmin permanece', removedUsers: removedUsers.length });
});

const buildTicketRows = () => {
	const raffleIndex = new Map(db.raffles.map((r) => [r.id, r]));
	const rows = [];
	db.purchases.forEach((p) => {
		const raffle = raffleIndex.get(p.raffleId);
		(p.numbers || []).forEach((number) => {
			rows.push({
				id: `${p.id}-${number}`,
				raffleId: p.raffleId,
				raffleTitle: raffle?.title,
				number,
				status: p.status || 'approved',
				buyer: p.buyer,
				createdAt: p.createdAt,
				via: p.via || 'wallet'
			});
		});
	});
	// include pending/rejected manual payments without numbers
	db.manualPayments.forEach((m) => {
		if (m.status === 'pending' || m.status === 'rejected') {
			const raffle = raffleIndex.get(m.raffleId);
			rows.push({
				id: m.id,
				raffleId: m.raffleId,
				raffleTitle: raffle?.title,
				number: null,
				status: m.status,
				buyer: snapshotBuyer(db.users.find((u) => u.id === m.userId)),
				createdAt: m.createdAt,
				via: 'manual'
			});
		}
	});
	return rows;
};

app.get('/admin/tickets', authMiddleware, adminMiddleware, (req, res) => {
	const { raffleId, status, from, to, format } = req.query;
	const fromTs = from ? Date.parse(from) : null;
	const toTs = to ? Date.parse(to) : null;
	const rows = buildTicketRows().filter((row) => {
		if (raffleId && row.raffleId !== raffleId) return false;
		if (status && row.status !== status) return false;
		if (fromTs && (!row.createdAt || row.createdAt < fromTs)) return false;
		if (toTs && (!row.createdAt || row.createdAt > toTs)) return false;
		return true;
	});

	if (format === 'csv' || format === 'excel') {
		const header = 'raffleId,raffleTitle,ticketNumber,status,firstName,lastName,email,phone,cedula,via,createdAt\n';
		const body = rows
			.map((row) => {
				const buyer = row.buyer || {};
				return [
					row.raffleId,
					row.raffleTitle,
					row.number ?? '',
					row.status,
					buyer.firstName || '',
					buyer.lastName || '',
					buyer.email || '',
					buyer.phone || '',
					buyer.cedula || '',
					row.via,
					row.createdAt ? new Date(row.createdAt).toISOString() : ''
				]
					.map((value) => `"${String(value).replace(/"/g, '""')}"`)
					.join(',');
			})
			.join('\n');
		return res
			.status(200)
			.set('Content-Type', 'text/csv')
			.set('Content-Disposition', 'attachment; filename="tickets.csv"')
			.send(header + body);
	}

	return res.json(rows);
});

// Admin: aprobar pago manual -> asignar numeros y registrar compra.
app.post('/admin/manual-payments/:id/approve', authMiddleware, adminMiddleware, (req, res) => {
	const payment = db.manualPayments.find((p) => p.id === req.params.id);
	if (!payment) return res.status(404).json({ error: 'Pago no encontrado' });
	if (payment.status !== 'pending') return res.status(400).json({ error: 'El pago ya fue procesado' });

	const raffle = db.raffles.find((r) => r.id === payment.raffleId);
	if (!raffle) return res.status(404).json({ error: 'Rifa no encontrada' });
	if (raffle.status !== 'active') return res.status(400).json({ error: 'La rifa ya no esta activa' });
	const organizer = db.users.find((u) => u.id === raffle.creatorId);
	const numbers = allocateRandomNumbers(raffle, payment.quantity);
	if (!numbers) return res.status(400).json({ error: 'No hay suficientes numeros disponibles' });
	const formattedNumbers = numbers.map(formatTicketNumber);
	const userRecord = db.users.find((u) => u.id === payment.userId);
	payment.status = 'approved';
	payment.processedAt = Date.now();
	payment.numbers = formattedNumbers;

	const amount = raffle.price * payment.quantity;
	const purchase = {
		id: uuid(),
		raffleId: raffle.id,
		userId: payment.userId,
		numbers: formattedNumbers,
		amount,
		via: 'manual',
		status: 'approved',
		createdAt: Date.now(),
		buyer: snapshotBuyer(userRecord)
	};
	db.purchases.push(purchase);
	const soldCount = getAssignedNumbers(raffle.id).size;
	raffle.nextTicket = soldCount + 1;
	sendTicketConfirmationEmail({ buyer: userRecord, raffle, numbers: formattedNumbers, organizer, purchaseDate: purchase.createdAt });
	const adminActor = db.users.find((u) => u.id === req.user.id);
	logActivity({ action: 'manualPayment.approve', userId: req.user.id, organizerId: adminActor?.organizerId, meta: { paymentId: payment.id, raffleId: raffle.id, numbers: formattedNumbers } });

	return res.json({ message: 'Pago aprobado y numeros asignados', numbers: formattedNumbers });
});

// Admin: rechazar pago manual.
app.post('/admin/manual-payments/:id/reject', authMiddleware, adminMiddleware, (req, res) => {
	const payment = db.manualPayments.find((p) => p.id === req.params.id);
	if (!payment) return res.status(404).json({ error: 'Pago no encontrado' });
	if (payment.status !== 'pending') return res.status(400).json({ error: 'El pago ya fue procesado' });

	payment.status = 'rejected';
	payment.processedAt = Date.now();
	const adminActor = db.users.find((u) => u.id === req.user.id);
	logActivity({ action: 'manualPayment.reject', userId: req.user.id, organizerId: adminActor?.organizerId, meta: { paymentId: payment.id, raffleId: payment.raffleId } });
	return res.json({ message: 'Pago rechazado' });
});

app.get('/users/:id/raffles', authMiddleware, (req, res) => {
	if (req.params.id !== req.user.id) return res.status(403).json({ error: 'No autorizado' });

	const userPurchases = db.purchases.filter((p) => p.userId === req.user.id);
	const grouped = userPurchases.reduce((acc, purchase) => {
		const existing = acc.get(purchase.raffleId) || [];
		acc.set(purchase.raffleId, existing.concat(purchase.numbers));
		return acc;
	}, new Map());

	const result = Array.from(grouped.entries()).map(([raffleId, numbers]) => {
		const raffle = db.raffles.find((r) => r.id === raffleId);
		const isWinner = raffle?.status === 'closed' && numbers.includes(raffle.winningTicketNumber);
		return { raffle, numbers, isWinner };
	});

	return res.json(result);
});

const buildUserTickets = (userId) => {
	const raffleIndex = new Map(db.raffles.map((r) => [r.id, r]));
	const rows = [];
	db.purchases
		.filter((p) => p.userId === userId)
		.forEach((p) => {
			const raffle = raffleIndex.get(p.raffleId);
			(p.numbers || []).forEach((number) => {
				const isWinner = raffle?.status === 'closed' && raffle?.winningTicketNumber === number;
				const isClosed = raffle?.status === 'closed';
				const baseStatus = p.status === 'approved' ? 'aprobado' : p.status || 'aprobado';
				rows.push({
					id: `${p.id}-${number}`,
					number,
					raffleId: p.raffleId,
					raffleTitle: raffle?.title,
					createdAt: p.createdAt,
					status: isWinner ? 'ganador' : isClosed ? 'perdedor' : baseStatus,
					via: p.via || 'wallet'
				});
			});
		});
	db.manualPayments
		.filter((m) => m.userId === userId && (m.status === 'pending' || m.status === 'rejected'))
		.forEach((m) => {
			const raffle = raffleIndex.get(m.raffleId);
			rows.push({
				id: m.id,
				number: null,
				raffleId: m.raffleId,
				raffleTitle: raffle?.title,
				createdAt: m.createdAt,
				status: m.status,
				via: 'manual'
			});
		});
	return rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
};

app.get('/me/tickets', authMiddleware, (req, res) => {
	return res.json(buildUserTickets(req.user.id));
});

app.post('/admin/push/broadcast', authMiddleware, adminMiddleware, async (req, res) => {
	const { title, body } = req.body || {};
	if (!title || !body) return res.status(400).json({ error: 'Título y mensaje requeridos' });

	const tokens = db.users
		.filter(u => u.pushToken && Expo.isExpoPushToken(u.pushToken))
		.map(u => u.pushToken);

	if (tokens.length === 0) return res.json({ message: 'No hay usuarios con token push registrado.' });

	const messages = tokens.map(token => ({
		to: token,
		sound: 'default',
		title,
		body,
		data: { withSome: 'data' },
	}));

	const chunks = expo.chunkPushNotifications(messages);
	const tickets = [];
	
	for (const chunk of chunks) {
		try {
			const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
			tickets.push(...ticketChunk);
		} catch (error) {
			console.error(error);
		}
	}

	logActivity({ action: 'admin.push.broadcast', userId: req.user.id, organizerId: req.user.organizerId, meta: { title, count: tokens.length } });
	return res.json({ message: `Enviado a ${tokens.length} dispositivos.` });
});

app.use((req, res) => {
	res.status(404).json({ error: 'Ruta no encontrada' });
});

// Error handler centralizado: evita filtrar stacktraces y asocia request-id
app.use((err, req, res, _next) => {
	// eslint-disable-next-line no-console
	console.error('Unhandled error', { reqId: req?.id, path: req?.path, message: err?.message });
	return res.status(500).json({ error: 'Ocurrió un error inesperado', requestId: req?.id });
});

app.listen(PORT, () => {
	// eslint-disable-next-line no-console
	console.log(`API escuchando en http://localhost:${PORT}`);
});
