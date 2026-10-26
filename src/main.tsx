import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <>
      {' '}
      <div
        style={{
          padding: '10px 20px',
          background: '#222',
          color: '#fff',
          fontSize: 13,
          textAlign: 'center',
        }}
      >
        Интерактивная демонстрация ·{' '}
        {import.meta.env.VITE_DEMO_MODE === 'true'
          ? 'Данные сохраняются только в этом браузере'
          : 'Локальный сервер и демонстрационные данные'}{' '}
        · Реальных услуг, оплаты и писем нет
      </div>
      <App />
    </>
  </StrictMode>,
);
