import {redisClient} from 'redis';

//We keep running this loop continuously in the background
export const startMatchmaker = () =>{
    console.log("Matchmaker worker started. Scanning for pools ...");

    setInterval(async()=>{
        try {
            const queues = await redisClient.keys('queue:*');

            for(const queueKey of queues){
                const waitingUsers = await redisClient.zRange(queueKey , 0 ,-1); //zRange returns a sorted set and we get all its elements from first to last
                if(waitingUsers.length < 2){
                    continue;
                }

                let matchFound = false;
                let userA , userB;

                for(const anchorUser of waitingUsers){
                    //Searching for users who are in the 1 km radius of the current user
                    const nearbyUsers = await redisClient.geoSearch(
                        queueKey , {member:anchorUser} , {radius:1 , unit:'km'}
                    );

                    if(nearbyUsers.length >=0){
                        userA = nearbyUsers[0];
                        userB = nearbyUsers[1];
                    }

                    //Getting all the details of the user from redis
                    const reqA = await redisClient.hGetAll(`request:${userA}`);
                    const reqB = await redisClient.hGetAll(`request:${userB}`);

                    //checking if the number of passengers can be accomodated
                    const totalPax = parseInt(reqA.party_size) + parseInt(reqB.party_size);

                    if(totalPax > 4){
                        console.log(`Capacity failed for ${userA} & ${userB}. (${totalPax} > 4). Trying next...`);
                        continue;
                    }

                    matchFound = true;

                    //Removing as soon as the parties are matched 
                    await redisClient.zRem(queueKey , [userA , userB]);

                    console.log("Perfect match in");
                    console.log(`User A: ${userA} | User B: ${userB} | Total Pax: ${totalPax}`);

                    break;
                }

                //Now we have a match and now we apply the ola maps api math for rest part
                if(matchFound){
                    
                }
            }
        } 
        catch (error) {
            console.error("Matchmaker Error:",error);
        }
    },5000);
}