import {createClient} from 'redis';
import dotenv from 'dotenv';

dotenv.config();

const redisClient = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
})

//Event listeners for debugging
redisClient.on('error' , (err)=> console.log(`Redis Client Error ${err}`));
redisClient.on('connect' , ()=> console.log("Redis Connected Successfully"));

const connectRedis = async() =>{
    if(!redisClient.isOpen){
        await redisClient.connect();
    }
}

export {redisClient , connectRedis} ;