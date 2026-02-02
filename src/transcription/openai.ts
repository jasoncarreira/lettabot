/**
 * OpenAI Whisper transcription service
 */

import OpenAI from 'openai';
import { loadConfig } from '../config/index.js';

let openaiClient: OpenAI | null = null;

function getClient(): OpenAI {
  if (!openaiClient) {
    const config = loadConfig();
    // Config takes priority, then env var
    const apiKey = config.transcription?.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OpenAI API key required for transcription. Set in config (transcription.apiKey) or OPENAI_API_KEY env var.');
    }
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

function getModel(): string {
  const config = loadConfig();
  return config.transcription?.model || process.env.TRANSCRIPTION_MODEL || 'whisper-1';
}

/**
 * Transcribe audio using OpenAI Whisper API
 * 
 * @param audioBuffer - The audio data as a Buffer
 * @param filename - Filename with extension (e.g., 'voice.ogg')
 * @returns The transcribed text
 */
export async function transcribeAudio(audioBuffer: Buffer, filename: string = 'audio.ogg'): Promise<string> {
  const client = getClient();
  
  // Create a File object from the buffer
  // OpenAI SDK expects a File-like object
  // Convert Buffer to Uint8Array to satisfy BlobPart type
  const file = new File([new Uint8Array(audioBuffer)], filename, { 
    type: getMimeType(filename) 
  });
  
  const response = await client.audio.transcriptions.create({
    file,
    model: getModel(),
  });
  
  return response.text;
}

/**
 * Get MIME type from filename extension
 */
function getMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  const mimeTypes: Record<string, string> = {
    'ogg': 'audio/ogg',
    'mp3': 'audio/mpeg',
    'mp4': 'audio/mp4',
    'm4a': 'audio/mp4',
    'wav': 'audio/wav',
    'webm': 'audio/webm',
    'mpeg': 'audio/mpeg',
    'mpga': 'audio/mpeg',
  };
  return mimeTypes[ext || ''] || 'audio/ogg';
}
