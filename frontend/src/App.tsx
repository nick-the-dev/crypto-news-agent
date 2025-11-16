import { useStreamingAnswer } from './hooks/useStreamingAnswer';
import { QuestionInput } from './components/QuestionInput';
import { LoadingIndicator } from './components/LoadingIndicator';
import { StructuredAnswer } from './components/StructuredAnswer';

function App() {
  const { isStreaming, status, streamingTldr, streamingDetails, answer, error, askQuestion } = useStreamingAnswer();

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
      <div className="container mx-auto px-4 py-8">
        <header className="text-center mb-12">
          <h1 className="text-5xl font-bold text-gray-900 mb-2">
            Crypto News Agent
          </h1>
          <p className="text-xl text-gray-600">
            AI-powered answers from the latest crypto news
          </p>
        </header>

        <QuestionInput onSubmit={askQuestion} disabled={isStreaming} />

        {error && (
          <div className="max-w-4xl mx-auto mb-8 bg-red-50 border-l-4 border-red-600 p-4 rounded-r-lg">
            <div className="flex items-center gap-2">
              <span className="text-2xl">⚠️</span>
              <p className="text-red-800">Error: {error}</p>
            </div>
          </div>
        )}

        {isStreaming && !answer && (
          <LoadingIndicator status={status} />
        )}

        {isStreaming && answer && (
          <StructuredAnswer answer={answer} streamingTldr={streamingTldr} streamingDetails={streamingDetails} />
        )}

        {!isStreaming && answer && (
          <StructuredAnswer answer={answer} />
        )}

        <footer className="text-center mt-16 text-gray-600 text-sm">
          Powered by OpenRouter • Sources: DL News, The Defiant
        </footer>
      </div>
    </div>
  );
}

export default App;
