import axios, { AxiosInstance } from 'axios';
import * as SecureStore from 'expo-secure-store';
import { API_BASE_URL, API_TIMEOUT } from './env';

let token: string | null = null;

export const api: AxiosInstance = axios.create({
  baseURL: API_BASE_URL,
  timeout: API_TIMEOUT,
});

api.interceptors.request.use(async (config) => {
  if (!token) token = await SecureStore.getItemAsync('jwt_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  response => response,
  error => {
    if (error.response) {
      throw new Error(error.response.data?.message || 'Error en la API');
    } else if (error.request) {
      throw new Error('No se pudo conectar con el servidor');
    } else {
      throw new Error('Error desconocido');
    }
  }
);

export async function checkApi() {
  try {
    const [health, status] = await Promise.all([
      api.get('/health'),
      api.get('/status'),
    ]);
    return { health: health.data, status: status.data };
  } catch (error) {
    throw error;
  }
}

export async function listRaffles() {
  try {
    const res = await api.get('/raffles');
    return res.data;
  } catch (error) {
    throw error;
  }
}

export async function createRaffle(raffle: { name: string }) {
  try {
    const res = await api.post('/raffles', raffle);
    return res.data;
  } catch (error) {
    throw error;
  }
}

export async function login(credentials: { email: string; password: string }) {
  try {
    const res = await api.post('/auth/login', credentials);
    token = res.data.token;
    await SecureStore.setItemAsync('jwt_token', token);
    return token;
  } catch (error) {
    throw error;
  }
}

export async function loadToken() {
  token = await SecureStore.getItemAsync('jwt_token');
  return token;
}

export async function logout() {
  token = null;
  await SecureStore.deleteItemAsync('jwt_token');
}
