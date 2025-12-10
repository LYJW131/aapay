import axios from 'axios';

const BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

// ==================== Token 管理 ====================

const TOKEN_KEY = 'aapay_token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (token) => localStorage.setItem(TOKEN_KEY, token);
export const removeToken = () => localStorage.removeItem(TOKEN_KEY);

// ==================== Axios 实例配置 ====================

const api = axios.create({
    baseURL: `${BASE_URL}/api`,
});

const adminApi = axios.create({
    baseURL: `${BASE_URL}/admin`,
});

const authApi = axios.create({
    baseURL: `${BASE_URL}/auth`,
});

// 请求拦截器：自动附加 Authorization header
const addAuthHeader = (config) => {
    const token = getToken();
    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
};

api.interceptors.request.use(addAuthHeader);
adminApi.interceptors.request.use(addAuthHeader);
authApi.interceptors.request.use(addAuthHeader);

// ==================== 原有 API ====================

export const getUsers = () => api.get('/users');
export const createUser = (name, avatar) => api.post('/users', { name, avatar });
export const updateUser = (id, name, avatar) => api.put(`/users/${id}`, { name, avatar });
export const deleteUser = (id) => api.delete(`/users/${id}`);

export const getExpenses = (date) => api.get('/expenses', { params: { date } });
export const createExpense = (expense) => api.post('/expenses', expense);
export const deleteExpense = (id) => api.delete(`/expenses/${id}`);

export const getDebts = (date) => api.get('/debts', { params: { date } });
export const getSummary = () => api.get('/summary');

// ==================== 管理员 API ====================

export const checkAdminAuth = () => adminApi.get('/auth');
export const getSessions = () => adminApi.get('/sessions');
export const createSession = (name) => adminApi.post('/sessions', { name });
export const deleteSession = (id) => adminApi.delete(`/sessions/${id}`);
export const switchSession = (id) => adminApi.post(`/sessions/${id}/switch`);
export const getPhrases = (sessionId) => adminApi.get(`/sessions/${sessionId}/phrases`);
export const createPhrase = (sessionId, data) => adminApi.post(`/sessions/${sessionId}/phrases`, data);
export const deletePhrase = (id) => adminApi.delete(`/phrases/${id}`);

// ==================== 认证 API ====================

export const exchangePhrase = (phrase) => authApi.post('/exchange', { phrase });
export const checkAuth = () => authApi.get('/check');
export const logout = () => {
    removeToken();
    return Promise.resolve({ data: { status: 'success' } });
};

// ==================== SSE ====================

export const subscribeToEvents = (onMessage, onError, onConnect) => {
    const token = getToken();

    // 原生 EventSource 不支持自定义 header
    // 使用 fetch + ReadableStream 实现带 header 的 SSE
    const controller = new AbortController();
    let isAborted = false;
    let reconnectDelay = 1000; // 初始重连延迟 1 秒
    const maxReconnectDelay = 30000; // 最大重连延迟 30 秒

    const connect = async () => {
        if (isAborted) return;

        try {
            const response = await fetch(`${BASE_URL}/api/events`, {
                headers: token ? { 'Authorization': `Bearer ${token}` } : {},
                signal: controller.signal
            });

            if (!response.ok) {
                throw new Error(`SSE Error: ${response.status}`);
            }

            // 连接成功，重置重连延迟并通知
            reconnectDelay = 1000;
            if (onConnect) onConnect();

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    // 连接正常结束，尝试重连
                    if (!isAborted) {
                        console.log('SSE connection closed, reconnecting...');
                        setTimeout(connect, reconnectDelay);
                    }
                    break;
                }

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.slice(6));
                            if (data.type !== 'heartbeat') {
                                onMessage(data);
                            }
                        } catch (e) {
                            console.error('SSE Parse Error', e);
                        }
                    }
                }
            }
        } catch (error) {
            if (error.name !== 'AbortError' && !isAborted) {
                console.error('SSE Error:', error);
                if (onError) onError(error);

                // 错误后自动重连，使用指数退避
                console.log(`SSE reconnecting in ${reconnectDelay / 1000}s...`);
                setTimeout(connect, reconnectDelay);
                reconnectDelay = Math.min(reconnectDelay * 2, maxReconnectDelay);
            }
        }
    };

    connect();

    return () => {
        isAborted = true;
        controller.abort();
    };
};

// ==================== Admin SSE ====================

export const subscribeToAdminEvents = (onMessage, onError, onConnect) => {
    const token = getToken();

    const controller = new AbortController();
    let isAborted = false;
    let reconnectDelay = 1000;
    const maxReconnectDelay = 30000;

    const connect = async () => {
        if (isAborted) return;

        try {
            const response = await fetch(`${BASE_URL}/admin/events`, {
                headers: token ? { 'Authorization': `Bearer ${token}` } : {},
                signal: controller.signal
            });

            if (!response.ok) {
                throw new Error(`Admin SSE Error: ${response.status}`);
            }

            reconnectDelay = 1000;
            if (onConnect) onConnect();

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    if (!isAborted) {
                        console.log('Admin SSE connection closed, reconnecting...');
                        setTimeout(connect, reconnectDelay);
                    }
                    break;
                }

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.slice(6));
                            if (data.type !== 'heartbeat') {
                                onMessage(data);
                            }
                        } catch (e) {
                            console.error('Admin SSE Parse Error', e);
                        }
                    }
                }
            }
        } catch (error) {
            if (error.name !== 'AbortError' && !isAborted) {
                console.error('Admin SSE Error:', error);
                if (onError) onError(error);

                console.log(`Admin SSE reconnecting in ${reconnectDelay / 1000}s...`);
                setTimeout(connect, reconnectDelay);
                reconnectDelay = Math.min(reconnectDelay * 2, maxReconnectDelay);
            }
        }
    };

    connect();

    return () => {
        isAborted = true;
        controller.abort();
    };
};
