import React, { useEffect, useState, useCallback } from 'react';
import Layout from './components/Layout';
import PageSettings from './components/PageSettings';
import ExpenseForm from './components/ExpenseForm';
import DailySummary from './components/DailySummary';
import DebtSettlement from './components/DebtSettlement';
import { NotificationProvider, useNotification } from './components/NotificationProvider';
import * as api from './services/api';

function AppContent() {
  const [users, setUsers] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [summary, setSummary] = useState({});
  const [debts, setDebts] = useState([]);
  const [connectionStatus, setConnectionStatus] = useState('connecting');
  const { addNotification } = useNotification();

  // Global Date State (Defaults to Today)
  const [globalDate, setGlobalDate] = useState(new Date().toISOString().split('T')[0]);

  const fetchData = useCallback(async () => {
    try {
      const [uRes, eRes, sRes, dRes] = await Promise.all([
        api.getUsers(),
        api.getExpenses(),
        api.getSummary(),
        api.getDebts()
      ]);
      setUsers(uRes.data);
      setExpenses(eRes.data);
      setSummary(sRes.data);
      setDebts(dRes.data);
    } catch (error) {
      console.error("Failed to fetch data", error);
    }
  }, []);

  useEffect(() => {
    fetchData();

    const closeSSE = api.subscribeToEvents((data) => {
      console.log("SSE Event:", data);
      fetchData();

      // 显示通知
      if (data.message && data.type !== 'heartbeat') {
        addNotification(data.message, data.action || 'info');
      }
    });

    setConnectionStatus('connected');

    return () => closeSSE();
  }, [fetchData, addNotification]);

  return (
    <Layout status={connectionStatus}>
      <div className="space-y-6">
        {/* PageSettings replaces UserManager and includes Date Picker */}
        <PageSettings
          users={users}
          globalDate={globalDate}
          setGlobalDate={setGlobalDate}
        />
        <ExpenseForm
          users={users}
          defaultDate={globalDate}
        />
      </div>
      <div className="space-y-6">
        <DebtSettlement debts={debts} />
        <DailySummary
          expenses={expenses}
          users={users}
          summary={summary}
          selectedDate={globalDate}
        />
      </div>
    </Layout>
  );
}

function App() {
  return (
    <NotificationProvider>
      <AppContent />
    </NotificationProvider>
  );
}

export default App;
