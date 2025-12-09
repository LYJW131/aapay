import React from 'react';
import { RefreshCw } from 'lucide-react';

const Layout = ({ children, status, sessionName }) => {
    return (
        <div className="min-h-screen bg-gray-50 flex flex-col items-center py-6 sm:py-12">
            <header className="w-full max-w-7xl px-4 flex justify-between items-center mb-6">
                <h1 className="text-3xl font-bold text-primary-dark flex-shrink-0">AAPay</h1>
                {sessionName && (
                    <div className="flex items-center gap-2 px-3 py-1 bg-primary/10 rounded-lg">
                        <span className="text-sm font-medium text-primary">{sessionName}</span>
                    </div>
                )}
                <div className="flex items-center gap-2 text-sm text-gray-500 flex-shrink-0">
                    <span className={`w-2 h-2 rounded-full ${status === 'connected' ? 'bg-green-500' : 'bg-red-500'}`}></span>
                    {status === 'connected' ? 'Connected' : 'Disconnected'}
                </div>
            </header>

            <main className="w-full max-w-7xl px-4 grid grid-cols-1 md:grid-cols-[380px_1fr] gap-6 pb-20">
                {children}
            </main>

            <footer className="fixed bottom-0 w-full bg-white border-t p-4 text-center text-gray-400 text-xs md:hidden">
                Aapay Mobile View
            </footer>
        </div>
    );
};

export default Layout;
