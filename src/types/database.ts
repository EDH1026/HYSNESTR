/**
 * Supabase database types — hand-crafted from migrations.
 * Regenerate with:
 *   npx supabase gen types typescript --project-id <id> > src/types/database.ts
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export interface Database {
  public: {
    Tables: {
      people: {
        Row: {
          id: string
          name: string
          rank: string
          role: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          rank: string
          role?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          name?: string
          rank?: string
          role?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }

      work_items: {
        Row: {
          id: string
          type: string
          name: string
          color: string | null
          start: string
          main_start: string | null
          end_date: string
          engagement_number: string | null
          client: string | null
          hashtags: string[]
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          type: string
          name: string
          color?: string | null
          start: string
          main_start?: string | null
          end_date: string
          engagement_number?: string | null
          client?: string | null
          hashtags?: string[]
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          type?: string
          name?: string
          color?: string | null
          start?: string
          main_start?: string | null
          end_date?: string
          engagement_number?: string | null
          client?: string | null
          hashtags?: string[]
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }

      profiles: {
        Row: {
          id: string
          name: string | null
          global_role: string
          person_id: string | null
          status: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id: string
          name?: string | null
          global_role?: string
          person_id?: string | null
          status?: string
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          name?: string | null
          global_role?: string
          person_id?: string | null
          status?: string
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'profiles_id_fkey'
            columns: ['id']
            referencedRelation: 'users'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'profiles_person_id_fkey'
            columns: ['person_id']
            referencedRelation: 'people'
            referencedColumns: ['id']
          },
        ]
      }

      assignments: {
        Row: {
          id: string
          person_id: string
          kind: string
          work_item_id: string | null
          weekend_dates: string[]
          leave_type: string | null
          start: string
          end_date: string
          note: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          person_id: string
          kind: string
          work_item_id?: string | null
          weekend_dates?: string[]
          leave_type?: string | null
          start: string
          end_date: string
          note?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          person_id?: string
          kind?: string
          work_item_id?: string | null
          weekend_dates?: string[]
          leave_type?: string | null
          start?: string
          end_date?: string
          note?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'assignments_person_id_fkey'
            columns: ['person_id']
            referencedRelation: 'people'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'assignments_work_item_id_fkey'
            columns: ['work_item_id']
            referencedRelation: 'work_items'
            referencedColumns: ['id']
          },
        ]
      }

      accruals: {
        Row: {
          id: string
          person_id: string
          type: string
          days: number
          date: string
          source: string | null
          note: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          person_id: string
          type: string
          days: number
          date: string
          source?: string | null
          note?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          person_id?: string
          type?: string
          days?: number
          date?: string
          source?: string | null
          note?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'accruals_person_id_fkey'
            columns: ['person_id']
            referencedRelation: 'people'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'accruals_source_fkey'
            columns: ['source']
            referencedRelation: 'work_items'
            referencedColumns: ['id']
          },
        ]
      }

      holidays: {
        Row: {
          id: string
          name: string
          date: string
          recurring: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          date: string
          recurring?: boolean
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          name?: string
          date?: string
          recurring?: boolean
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }

      grants: {
        Row: {
          id: string
          user_id: string
          scope: string
          resource_id: string | null
          level: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          user_id: string
          scope: string
          resource_id?: string | null
          level: string
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          scope?: string
          resource_id?: string | null
          level?: string
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'grants_user_id_fkey'
            columns: ['user_id']
            referencedRelation: 'users'
            referencedColumns: ['id']
          },
        ]
      }

      audit_log: {
        Row: {
          id: string
          user_id: string | null
          action: string
          target_type: string
          target_id: string | null
          payload: Json | null
          at: string
        }
        Insert: {
          id?: string
          user_id?: string | null
          action: string
          target_type: string
          target_id?: string | null
          payload?: Json | null
          at?: string
        }
        Update: {
          id?: string
          user_id?: string | null
          action?: string
          target_type?: string
          target_id?: string | null
          payload?: Json | null
          at?: string
        }
        Relationships: []
      }
    }

    Views: Record<string, never>

    Functions: {
      app_can: {
        Args: { _scope: string; _resource: string | null; _need: string }
        Returns: boolean
      }
      is_admin: {
        Args: Record<PropertyKey, never>
        Returns: boolean
      }
      is_pipeline_work_item: {
        Args: { _id: string | null }
        Returns: boolean
      }
    }

    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
