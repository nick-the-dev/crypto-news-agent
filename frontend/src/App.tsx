import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ChatProvider } from './context/ChatContext';
import { ChatSidebar } from './components/ChatSidebar';
import { ChatPage } from './pages/ChatPage';

function AppLayout() {
  return (
    <div className="flex h-screen bg-gray-100">
      <ChatSidebar />
      <main className="flex-1 flex flex-col overflow-hidden">
        <Routes>
          <Route path="/" element={<ChatPage />} />
          <Route path="/chat/:threadId" element={<ChatPage />} />
        </Routes>
      </main>
    </div>
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
