import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ChatProvider } from '@/context/ChatContext';
import { ThemeProvider } from '@/components/theme-provider';
import { AppSidebar } from '@/components/app-sidebar';
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar';
import { ChatPage } from '@/pages/ChatPage';

function AppLayout() {
  return (
    <SidebarProvider defaultOpen={true}>
      <AppSidebar />
      <SidebarInset>
        <main className="flex-1 flex flex-col overflow-hidden">
          <Routes>
            <Route path="/" element={<ChatPage />} />
            <Route path="/chat" element={<ChatPage />} />
            <Route path="/chat/:threadId" element={<ChatPage />} />
          </Routes>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}

function App() {
  return (
    <ThemeProvider defaultTheme="dark" storageKey="crypto-news-ui-theme">
      <BrowserRouter>
        <ChatProvider>
          <AppLayout />
        </ChatProvider>
      </BrowserRouter>
    </ThemeProvider>
  );
}

export default App;
