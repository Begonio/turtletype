import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import AppPage from './pages/AppPage';
import Landing from './pages/Landing';
import { useJobStore } from './store/useJobStore';

export default function App() {
  const loadUser = useJobStore((state) => state.loadUser);

  useEffect(() => {
    void loadUser();
  }, [loadUser]);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/app" element={<AppPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
