import React, { useState, useRef, useEffect } from 'react';
import { X, Bell, UserPlus, Receipt, Trash2, Edit, Plus, AlertCircle, CheckCircle } from 'lucide-react';

// 根据通知类型获取图标
const getIcon = (type) => {
    switch (type) {
        case 'user_add': return <UserPlus size={18} />;
        case 'user_delete': return <Trash2 size={18} />;
        case 'user_update': return <Edit size={18} />;
        case 'expense_add': return <Receipt size={18} />;
        case 'expense_delete': return <Trash2 size={18} />;
        case 'add': return <Plus size={18} />;
        case 'delete': return <Trash2 size={18} />;
        case 'update': return <Edit size={18} />;
        case 'success': return <CheckCircle size={18} />;
        case 'error': return <AlertCircle size={18} />;
        default: return <Bell size={18} />;
    }
};

// 根据通知类型获取颜色
const getColor = (type) => {
    if (type === 'error') return 'bg-red-500';
    if (type.includes('delete')) return 'bg-red-500';
    if (type === 'success' || type.includes('add')) return 'bg-green-500';
    if (type.includes('update')) return 'bg-blue-500';
    return 'bg-primary';
};

const NotificationItem = ({ notification, onRemove }) => {
    const [touchStartX, setTouchStartX] = useState(null);
    const [translateX, setTranslateX] = useState(0);
    const [height, setHeight] = useState(null);
    const contentRef = useRef(null);

    const handleClose = () => {
        onRemove(notification.id);
    };

    // 测量实际高度（包含 padding 来容纳阴影）
    useEffect(() => {
        if (contentRef.current && height === null) {
            // 内容高度 + 底部间距 + 阴影空间
            setHeight(contentRef.current.offsetHeight + 16);
        }
    }, [height]);

    // 触摸滑动处理（移动端）
    const handleTouchStart = (e) => {
        setTouchStartX(e.touches[0].clientX);
    };

    const handleTouchMove = (e) => {
        if (touchStartX === null) return;
        const diff = e.touches[0].clientX - touchStartX;
        setTranslateX(diff);
    };

    const handleTouchEnd = () => {
        if (Math.abs(translateX) > 100) {
            handleClose();
        } else {
            setTranslateX(0);
        }
        setTouchStartX(null);
    };

    // 判断是否移动端
    const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;

    // 计算容器高度
    const containerHeight = notification.isExiting ? 0 : (height || 'auto');

    return (
        <div
            style={{
                height: containerHeight,
                transition: 'height 300ms ease-out',
                overflow: 'visible',
            }}
        >
            <div
                ref={contentRef}
                className={`
                    flex items-center gap-3 p-4 rounded-apple shadow-lg
                    bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700
                    ${!notification.isExiting ? (isMobile ? 'animate-slide-down' : 'animate-slide-left') : ''}
                `}
                style={{
                    transition: 'transform 300ms ease-out, opacity 300ms ease-out',
                    transform: notification.isExiting
                        ? (isMobile ? 'translateY(-20px)' : 'translateX(100%)')
                        : translateX !== 0
                            ? `translateX(${translateX}px)`
                            : 'translateX(0)',
                    opacity: notification.isExiting ? 0 : 1,
                    marginBottom: '8px',
                }}
                onTouchStart={handleTouchStart}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
            >
                {/* 图标 */}
                <div className={`w-9 h-9 rounded-full ${getColor(notification.type)} text-white flex items-center justify-center flex-shrink-0`}>
                    {getIcon(notification.type)}
                </div>

                {/* 消息内容 */}
                <p className="flex-1 text-sm text-gray-800 dark:text-gray-100 font-medium">
                    {notification.message}
                </p>

                {/* 关闭按钮 */}
                <button
                    onClick={handleClose}
                    className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors p-1"
                >
                    <X size={16} />
                </button>
            </div>
        </div>
    );
};

const NotificationToast = ({ notifications, onRemove }) => {
    const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;

    // 如果没有通知，不渲染任何内容
    if (notifications.length === 0) {
        return null;
    }

    return (
        <div
            className={`
                fixed z-50 pointer-events-none
                ${isMobile
                    ? 'top-0 left-0 right-0 p-4'
                    : 'top-4 right-4 w-80'
                }
            `}
            style={{ overflow: 'visible' }}
        >
            <div className="pointer-events-auto" style={{ overflow: 'visible' }}>
                {notifications.map((notification) => (
                    <NotificationItem
                        key={notification.id}
                        notification={notification}
                        onRemove={onRemove}
                    />
                ))}
            </div>
        </div>
    );
};

export default NotificationToast;
