import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ChatProvider } from '@/context/ChatContext';
import { ThemeProvider } from '@/components/theme-provider';
import { AppSidebar } from '@/components/app-sidebar';
import { SidebarProvider, SidebarInset, SidebarTrigger } from '@/components/ui/sidebar';
import { ChatPage } from '@/pages/ChatPage';
import { Separator } from '@/components/ui/separator';

function AppLayout() {
  return (
    <SidebarProvider defaultOpen={true}>
      <AppSidebar />
      <SidebarInset>
        {/* Mobile header with sidebar trigger */}
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4 md:hidden">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4" />
          <span className="font-semibold text-sm">Crypto News Agent</span>
        </header>
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
