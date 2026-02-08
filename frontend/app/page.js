'use client';

import { useState } from 'react';

export default function HomePage() {
  const [message, setMessage] = useState('Нажмите кнопку');
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    setLoading(true);
    try {
      const response = await fetch('/api/ping', { method: 'GET' });
      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }

      const data = await response.json();
      setMessage(data.message);
    } catch (error) {
      setMessage(`Ошибка: ${error.message}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ padding: 24, fontFamily: 'sans-serif' }}>
      <h1>Next.js + Python API</h1>
      <button onClick={handleClick} disabled={loading}>
        {loading ? 'Загрузка...' : 'Проверить backend'}
      </button>
      <p>{message}</p>
    </main>
  );
}
