interface Props {
  status: string;
}

export function LoadingIndicator({ status }: Props) {
  return (
    <div className="flex flex-col items-center justify-center py-12">
      <div className="relative w-16 h-16 mb-4">
        <div className="absolute top-0 left-0 w-full h-full border-4 border-blue-200 rounded-full animate-spin border-t-blue-600"></div>
        <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 text-2xl">
          🤖
        </div>
      </div>
      <p className="text-gray-600">{status}</p>
    </div>
  );
}
