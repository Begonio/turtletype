import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import AppPage from './pages/AppPage';
import Landing from './pages/Landing';
import Billing from './pages/Billing';
import { Privacy, Terms } from './pages/Legal';
import Pricing from './pages/Pricing';
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
        <Route path="/pricing" element={<Pricing />} />
        <Route path="/billing" element={<Billing />} />
        {/* Google's OAuth verification requires the privacy policy to be
            reachable at a stable URL on the verified domain and linked from
            the homepage, so these are real routes, not a footer modal. */}
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
