import React, { useState, useEffect } from 'react';
import { RefreshCw } from 'lucide-react';

const Layout = ({ children, status, sessionName }) => {
    // 用于平滑过渡的状态
    const [displayName, setDisplayName] = useState(sessionName);
    const [isTransitioning, setIsTransitioning] = useState(false);

    useEffect(() => {
        if (sessionName !== displayName) {
            // 开始淡出
            setIsTransitioning(true);
            // 淡出后更新名称并淡入
            const timer = setTimeout(() => {
                setDisplayName(sessionName);
                setIsTransitioning(false);
            }, 150);
            return () => clearTimeout(timer);
        }
    }, [sessionName, displayName]);

    return (
        <div 
            className="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col items-center py-6 sm:py-12"
            style={{ paddingTop: 'max(env(safe-area-inset-top, 0px), 1.5rem)' }}
        >
            <header className="w-full max-w-7xl px-4 flex justify-between items-center mb-6">
                <h1 className="text-3xl font-bold text-primary-dark dark:text-primary flex-shrink-0">AAPay</h1>
                <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 flex-shrink-0">
                    <span className={`w-2 h-2 rounded-full ${status === 'connected' ? 'bg-green-500' : 'bg-red-500'}`}></span>
                    {status === 'connected' ? 'Connected' : 'Disconnected'}
                </div>
            </header>

            <main className="w-full max-w-7xl px-4 grid grid-cols-1 md:grid-cols-[380px_1fr] gap-6 pb-6">
                {children}
            </main>
        </div>
    );
};

export default Layout;
