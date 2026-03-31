import "./globals.css";

export const metadata = {
  title: "Voice Agent",
  description: "Talk with the voice agent — mic on, interrupt when you speak",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
