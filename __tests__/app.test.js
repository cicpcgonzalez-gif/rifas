const request = require('supertest');
const app = require('../src/index');

describe('Health Endpoint', () => {
  it('should return 200 OK for GET /health', async () => {
    const response = await request(app)
      .get('/health')
      .expect(200);
    
    expect(response.body).toHaveProperty('status', 'ok');
    expect(response.body).toHaveProperty('message');
    expect(response.body).toHaveProperty('timestamp');
  });

  it('should return 200 OK for GET /status', async () => {
    const response = await request(app)
      .get('/status')
      .expect(200);
    
    expect(response.body).toHaveProperty('status', 'ok');
  });
});

describe('Raffles Endpoint', () => {
  it('should return 401 for GET /raffles without token', async () => {
    await request(app)
      .get('/raffles')
      .expect(401);
  });

  it('should return 401 with invalid token', async () => {
    await request(app)
      .get('/raffles')
      .set('Authorization', 'Bearer invalid-token')
      .expect(401);
  });
});

describe('404 Handler', () => {
  it('should return 404 for non-existent routes', async () => {
    const response = await request(app)
      .get('/non-existent-route')
      .expect(404);
    
    expect(response.body).toHaveProperty('error', 'Route not found');
  });
});
