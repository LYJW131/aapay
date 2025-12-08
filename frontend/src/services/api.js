import axios from 'axios';

const API_URL = 'http://localhost:8000/api';

const api = axios.create({
    baseURL: API_URL,
});

export const getUsers = () => api.get('/users');
export const createUser = (name, avatar) => api.post('/users', { name, avatar });
export const updateUser = (id, name, avatar) => api.put(`/users/${id}`, { name, avatar });
export const deleteUser = (id) => api.delete(`/users/${id}`);

export const getExpenses = (date) => api.get('/expenses', { params: { date } });
export const createExpense = (expense) => api.post('/expenses', expense);
export const deleteExpense = (id) => api.delete(`/expenses/${id}`);

export const getDebts = () => api.get('/debts');
export const getSummary = () => api.get('/summary');

export const subscribeToEvents = (onMessage) => {
    const eventSource = new EventSource(`${API_URL}/events`);

    eventSource.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.type !== 'heartbeat') {
                onMessage(data);
            }
        } catch (error) {
            console.error('SSE Parse Error', error);
        }
    };

    return () => {
        eventSource.close();
    };
};
