import React, { createContext, useContext, useState, useCallback } from 'react';
import NotificationToast from './NotificationToast';

const NotificationContext = createContext(null);

export const useNotification = () => {
    const context = useContext(NotificationContext);
    if (!context) {
        throw new Error('useNotification must be used within NotificationProvider');
    }
    return context;
};

let notificationId = 0;

export const NotificationProvider = ({ children }) => {
    const [notifications, setNotifications] = useState([]);

    // 标记通知开始退出（触发动画）
    const startExitNotification = useCallback((id) => {
        setNotifications(prev => prev.map(n =>
            n.id === id ? { ...n, isExiting: true } : n
        ));
        // 动画完成后真正移除
        setTimeout(() => {
            setNotifications(prev => prev.filter(n => n.id !== id));
        }, 300);
    }, []);

    const addNotification = useCallback((message, type = 'info') => {
        const id = ++notificationId;
        setNotifications(prev => [...prev, { id, message, type, isExiting: false }]);

        // 自动移除（PC 4秒，移动端 3秒）
        const duration = window.innerWidth >= 640 ? 4000 : 3000;
        setTimeout(() => {
            startExitNotification(id);
        }, duration);

        return id;
    }, [startExitNotification]);

    const removeNotification = useCallback((id) => {
        startExitNotification(id);
    }, [startExitNotification]);

    return (
        <NotificationContext.Provider value={{ addNotification, removeNotification }}>
            {children}
            <NotificationToast notifications={notifications} onRemove={removeNotification} />
        </NotificationContext.Provider>
    );
};

export default NotificationProvider;
