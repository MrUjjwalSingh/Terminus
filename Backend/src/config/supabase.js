import {createClient} from '@supabase/supabase-js';
import dotenv from 'dotenv';

//Load environment varibles
dotenv.config();

const supabaseURL = process.env.SUPABASE_URL;
const supabaseKEY = process.env.SUPABASE_SECRET_KEY;

if(!supabaseKEY || !supabaseURL){
    throw new ERROR("Missing Supabase environment variable!");
}

//Initialize the supabase client with admin privileges for the backend
const supabase = createClient(supabaseURL , supabaseKEY);

console.log("Supabase client initialized successfully");

export {supabase};