export const metadata = {
  title: 'Next + FastAPI Demo',
  description: 'Minimal docker-compose setup',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
