import { NextResponse } from 'next/server';

const backendUrl = process.env.BACKEND_URL || 'http://backend:8000';

export async function GET() {
  try {
    const response = await fetch(`${backendUrl}/ping`, { cache: 'no-store' });

    if (!response.ok) {
      return NextResponse.json(
        { message: `Backend error: ${response.status}` },
        { status: 502 }
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json(
      { message: `Cannot reach backend: ${error.message}` },
      { status: 502 }
    );
  }
}
