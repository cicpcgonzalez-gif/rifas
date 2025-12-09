const fs = require('fs');
const { v4: uuid } = require('uuid');

// Seeded users
const users = [
  {
    id: uuid(),
    email: 'cicpcgonzalez@gmail.com',
    password: '123456789',
    role: 'admin',
    verified: false,
    isVerified: false,
    active: true,
    organizerId: 'ORG1',
    phone: '+584000000000',
    address: 'Demo',
    firstName: 'Admin',
    lastName: 'Seed',
    support: { whatsapp: '+584000000000', instagram: '@rifas_admin' },
    securityCodeHash: '',
    securityCodeUpdatedAt: Date.now()
  },
  {
    id: uuid(),
    email: 'rifa@megarifasapp.com',
    password: 'rifasadmin123',
    role: 'superadmin',
    verified: true,
    isVerified: true,
    active: true,
    organizerId: 'SUPERADMIN',
    phone: '+10000000000',
    address: 'HQ',
    firstName: 'Super',
    lastName: 'Admin',
    support: { email: 'rifa@megarifasapp.com', whatsapp: '', instagram: '', website: 'https://megarifasapp.com' },
    securityCodeHash: '',
    securityCodeUpdatedAt: Date.now(),
    twoFactorEnabled: false
  }
];

fs.writeFileSync('../users.json', JSON.stringify(users, null, 2));

const raffles = [
  {
    id: uuid(),
    title: 'Rifas Sergio Palomino',
    description: 'Premios tech y gadgets cada semana.',
    price: 5,
    creatorId: users[0].id,
    organizerId: users[0].organizerId,
    status: 'active',
    winningTicketNumber: null,
    nextTicket: 1,
    createdAt: Date.now(),
    startDate: new Date().toISOString(),
    endDate: null,
    totalTickets: 500,
    style: {}
  },
  {
    id: uuid(),
    title: 'Rifas Gato',
    description: 'Electrodomésticos y hogar.',
    price: 3,
    creatorId: users[0].id,
    organizerId: users[0].organizerId,
    status: 'active',
    winningTicketNumber: null,
    nextTicket: 1,
    createdAt: Date.now(),
    startDate: new Date().toISOString(),
    endDate: null,
    totalTickets: 400,
    style: {}
  },
  {
    id: uuid(),
    title: 'Rifas Adrián',
    description: 'Moda y accesorios premium.',
    price: 4,
    creatorId: users[0].id,
    organizerId: users[0].organizerId,
    status: 'active',
    winningTicketNumber: null,
    nextTicket: 1,
    createdAt: Date.now(),
    startDate: new Date().toISOString(),
    endDate: null,
    totalTickets: 350,
    style: {}
  }
];

fs.writeFileSync('../raffles.json', JSON.stringify(raffles, null, 2));
console.log('Datos extraídos y guardados en users.json y raffles.json');
