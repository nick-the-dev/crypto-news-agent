import { useState, createContext, useContext } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ChatProvider } from './context/ChatContext';
import { ChatSidebar } from './components/ChatSidebar';
import { ChatPage } from './pages/ChatPage';

// Sidebar context for mobile toggle
interface SidebarContextType {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  toggle: () => void;
}

const SidebarContext = createContext<SidebarContextType | null>(null);

export function useSidebar() {
  const context = useContext(SidebarContext);
  if (!context) {
    throw new Error('useSidebar must be used within SidebarProvider');
  }
  return context;
}

function AppLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const sidebarContext: SidebarContextType = {
    isOpen: sidebarOpen,
    setIsOpen: setSidebarOpen,
    toggle: () => setSidebarOpen(prev => !prev),
  };

  return (
    <SidebarContext.Provider value={sidebarContext}>
      <div className="flex h-screen bg-gray-100">
        {/* Mobile overlay */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 bg-black/50 z-40 md:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}
        <ChatSidebar />
        <main className="flex-1 flex flex-col overflow-hidden">
          <Routes>
            <Route path="/" element={<ChatPage />} />
            <Route path="/chat" element={<ChatPage />} />
            <Route path="/chat/:threadId" element={<ChatPage />} />
          </Routes>
        </main>
      </div>
    </SidebarContext.Provider>
  );
}

function App() {
  return (
    <BrowserRouter>
      <ChatProvider>
        <AppLayout />
      </ChatProvider>
    </BrowserRouter>
  );
}

export default App;
