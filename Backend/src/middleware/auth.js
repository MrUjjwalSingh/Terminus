import { supabase } from "../config/supabase.js";

//Since we are going to use the authentication services provided by the supabase which will take care of the jwt access and refresh tokens , we jsut need to check if the user coming at the server contains a jwt access token or not.

export const socketAuthMiddleware = async (socket , next) =>{
    const token = socket.handshake.auth.token ;

    if(!token){
        console.log("Connection rejected: No token provided");
        return next(new Error("Authentication error , no token provided!"));
    }

    try {
        //Verify the token with supabase
        const {data , error} = await supabase.auth.getUser(token);

        if(error || !data.user){
            console.log("Connection rejected: Invalid Token");
            return next(new Error("Authentication error: Invalid token"))
        }

        //Success , attach the verified userID to the socket object
        socket.userId = data.user.id;
        next();
        
    } catch (err) {
        console.error("Auth middleware error:", err);
        return next(new Error("Internal server error during authentication"));
    }
}