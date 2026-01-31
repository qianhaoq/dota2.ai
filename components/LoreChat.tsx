import React, { useState, useRef, useEffect } from 'react';
import { ChatMessage } from '../types';
import { chatWithShopkeeper } from '../services/geminiService';
import { Send, Scroll } from 'lucide-react';

const LoreChat: React.FC = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'init',
      role: 'model',
      text: "Greetings, traveler. What knowledge do you seek from the Secret Shop? I have wares... and stories, if you have the coin.",
      timestamp: new Date()
    }
  ]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || isTyping) return;

    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      text: input,
      timestamp: new Date()
    };

    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsTyping(true);

    // Prepare history for Gemini
    const history = messages.map(m => ({
      role: m.role,
      parts: [{ text: m.text }]
    }));

    const responseText = await chatWithShopkeeper(history, userMsg.text);

    const modelMsg: ChatMessage = {
      id: (Date.now() + 1).toString(),
      role: 'model',
      text: responseText,
      timestamp: new Date()
    };

    setMessages(prev => [...prev, modelMsg]);
    setIsTyping(false);
  };

  return (
    <div className="h-full flex flex-col items-center justify-center max-w-4xl mx-auto">
      <div className="w-full h-[600px] glass-panel rounded-xl flex flex-col overflow-hidden relative border border-dota-gold/30">
        
        {/* Header */}
        <div className="p-4 bg-black/40 border-b border-gray-700 flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-dota-gold/20 flex items-center justify-center border border-dota-gold">
                <Scroll size={20} className="text-dota-gold" />
            </div>
            <div>
                <h3 className="text-dota-gold font-display font-bold">The Secret Shopkeeper</h3>
                <p className="text-xs text-gray-400">Keeper of Ancient Lore</p>
            </div>
        </div>

        {/* Messages */}
        <div className="flex-grow overflow-y-auto p-6 space-y-6 custom-scrollbar bg-[url('https://cdn.pixabay.com/photo/2016/06/02/02/33/triangles-1430105_1280.png')] bg-cover bg-blend-overlay bg-black/80">
          {messages.map((msg) => (
            <div 
              key={msg.id} 
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div className={`
                max-w-[80%] p-4 rounded-lg text-sm leading-relaxed shadow-lg
                ${msg.role === 'user' 
                  ? 'bg-dota-blue/20 border border-dota-blue/50 text-blue-100 rounded-tr-none' 
                  : 'bg-[#1a1a1a] border border-dota-gold/30 text-amber-100 rounded-tl-none font-serif'}
              `}>
                {msg.text}
              </div>
            </div>
          ))}
          {isTyping && (
             <div className="flex justify-start">
               <div className="bg-[#1a1a1a] border border-gray-700 p-3 rounded-lg rounded-tl-none">
                 <div className="flex gap-1">
                   <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce"></div>
                   <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce delay-75"></div>
                   <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce delay-150"></div>
                 </div>
               </div>
             </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="p-4 bg-black/60 border-t border-gray-700 flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder="Ask about the Aegis, Roshan, or the Mad Moon..."
            className="flex-grow bg-gray-900 border border-gray-700 rounded px-4 py-3 text-gray-200 focus:outline-none focus:border-dota-gold transition-colors placeholder-gray-600"
          />
          <button 
            onClick={handleSend}
            disabled={isTyping}
            className="bg-dota-gold hover:bg-amber-400 text-black font-bold p-3 rounded transition-colors disabled:opacity-50"
          >
            <Send size={20} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default LoreChat;